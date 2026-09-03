import {createHash} from 'crypto';
import {existsSync, readFileSync} from 'fs';
import {join} from 'path';
import {PatchTarget, parsePatch, parsePatchName, splitPatchHeader} from './patch-file';
import {patchesDirectory, atomicWrite, ensureDir, resolvePackagePath, stripPathPrefix} from './paths';

// Запись о том, что и когда легло в дерево. Нужна затем, чтобы на вопрос «что
// сейчас в node_modules» был ответ, не требующий разбирать патчи глазами.
//
// Лежит рядом с замком, а не внутри каталога пакета: patch-package кладёт свой
// `.patch-package.json` прямо в пакет, и такой файл попадает в дифф следующего
// патча — при разборе его исходников это видно, и повторять это незачем.
// Заодно у записи ровно та же жизнь, что у node_modules, которые она описывает.
export const STATE_FILE = join('node_modules', '.bunch-package-state.json');

const VERSION = 1;

export interface RecordedPatch {
  file: string; // имя файла в patches/
  packageDir: string; // каталог в node_modules, со слэшем для скоупа
  version: string;
  sha256: string; // хеш файла патча на момент применения
  // Хеш одного лишь тела, без заголовка. Заголовок — это «зачем этот патч
  // существует»; на дерево он не влияет, и правка одной его строки не должна
  // выглядеть как «патч переписали после того, как он лёг». Поля может не быть:
  // записи, сделанные до появления заголовков, читаются как прежде.
  bodySha256?: string;
  appliedAt: string; // ISO-8601
  // Файлы дерева, которых патч касался, — такими, какими их видел последний
  // успешный `apply`: правку, сделанную в node_modules мимо патчей, он тоже
  // запомнит, и это верно, потому что вопрос к записи один — «менялось ли
  // дерево с тех пор, как этот патч в нём лежал». Нужны
  // ровно затем, чтобы «файл патча с тех пор переписали» можно было превратить
  // в утверждение о дереве: если ни один из них не изменился, прежняя правка
  // всё ещё в node_modules. Без этого запись говорит только про сам патч, а
  // отказывать по ней было бы отказом на пустом месте у того, кто просто
  // переустановил пакет. Ключ — путь как он стоит в патче, `node_modules/<…>`;
  // значение — sha256 файла или null, когда файла нет (патч его удаляет).
  // Поля может не быть: записи, сделанные прежними версиями, читаются как были.
  files?: Record<string, string | null>;
}

export interface State {
  version: number;
  patches: RecordedPatch[];
}

// Хеши считаются от уже прочитанного файла, а не читают его сами: их всегда
// спрашивают парой и вместе с заголовком, и, пока каждый открывал файл сам,
// `status` открывал файл патча четыре раза на патч, а `recordPatches` — три.
//
// Весь файл хешируется байтами, а тело — строкой: так было и раньше, и от
// этого зависит, узнает ли `status` уже записанный патч. Байты патча, который
// не читается как UTF-8, через строку не прошли бы неизменными.
export function hashPatchFile(raw: Buffer): string {
  return createHash('sha256').update(raw).digest('hex');
}

export function hashPatchBody(content: string): string {
  return createHash('sha256').update(splitPatchHeader(content).body).digest('hex');
}

// Файла нет — это тоже состояние, и оно значимо: патч на удаление именно им и
// узнаётся. Отличать «нет» от «не прочли» здесь не нужно: непрочитанный файл
// уронит сбор целиком, и тогда доказывать будет нечем — см. filesLeftBy().
function hashTreeFile(path: string): string | null {
  return existsSync(path) ? createHash('sha256').update(readFileSync(path)).digest('hex') : null;
}

// Путь, по которому файл оказывается после применения секции: новая сторона
// заголовка, а у удаления от неё остаётся только старая. Переименование
// отдельно не разбирается — git пишет новый путь уже в `diff --git a/… b/…`,
// и `rename to` его лишь повторяет: снятая ветка для него не изменила ни одной
// записи, то есть была вторым замком на той же двери.
function pathAfterApply(target: PatchTarget): string | null {
  const raw = target.newPath ?? target.oldPath;
  return raw === null ? null : stripPathPrefix(raw);
}

// Снимок дерева на момент, когда патч в нём лежал. Собирается по самому патчу:
// какие файлы он назвал, такие и хешируются. Не собралось — записи о файлах не
// будет вовсе, и проверка «дерево не трогали» честно ответит «не знаю».
function filesLeftBy(content: string): Record<string, string | null> | undefined {
  try {
    const targets = parsePatch(content);
    if (targets.length === 0) return undefined;

    const files: Record<string, string | null> = {};
    for (const target of targets) {
      const relative = pathAfterApply(target);
      if (relative === null) return undefined;
      files[relative] = hashTreeFile(resolvePackagePath(relative));
    }
    return files;
  } catch {
    return undefined;
  }
}

// Файл патча описывает уже не ту правку, что легла в дерево. Заголовок не в
// счёт: он объясняет, зачем патч существует, и дерева не касается.
export function patchBodyChanged(record: RecordedPatch, raw: Buffer, content: string): boolean {
  return !sameChange(record, hashPatchFile(raw), hashPatchBody(content));
}

// Дерево ровно такое, каким его оставил записанный патч: ни один из файлов, к
// которым он прикасался, с тех пор не изменился. Возвращается один из них — тот,
// на который можно показать пальцем в отказе.
//
// Это и есть доказательство, что прежняя правка на месте. Сама запись им не
// является ([[DEC-11]]): она говорит, что было, а спрашивают про дерево — вот
// дерево и спрашиваем. Ни одного файла в записи нет (её писала прежняя версия) —
// значит доказательства нет, и молчать об этом нельзя так же, как и отказывать.
export function unchangedTreeWitness(record: RecordedPatch): string | null {
  const entries = Object.entries(record.files ?? {});
  if (entries.length === 0) return null;

  try {
    if (entries.some(([relative, sha]) => hashTreeFile(resolvePackagePath(relative)) !== sha)) return null;
  } catch {
    return null; // путь наружу проекта — про это скажет проверка, у которой диагноз точнее
  }

  // Показывать надо на файл, который есть. Патч, удаляющий файл, оставляет в
  // записи null, и «этот файл всё ещё такой» про отсутствующий файл человеку
  // нечем проверить; а патч, который только удаляет, и не дошёл бы сюда —
  // удалённое считается лежащим в дереве при любой версии такого патча.
  const present = entries.find(([, sha]) => sha !== null);
  return present === undefined ? null : present[0];
}

// Запись — это только запись. Считать по ней, что патч на месте, нельзя:
// файлы в node_modules меняются мимо нас, и единственное настоящее
// доказательство — обратное применение к самому дереву.
export function readState(): State | null {
  if (!existsSync(STATE_FILE)) return null;

  try {
    const parsed = JSON.parse(readFileSync(STATE_FILE, 'utf-8'));
    if (parsed?.version !== VERSION || !Array.isArray(parsed.patches)) return null;
    return parsed as State;
  } catch {
    // Битую запись молча заменим следующим apply: это не источник истины, и
    // ронять из-за неё прогон было бы обидно.
    return null;
  }
}

// Спрашивают запись всегда про конкретный патч: apply — когда он лёг в первый
// раз, status — время и хеш, create — какой патч последовательности был
// последним лежащим. Раскладка по именам файлов жила тремя копиями, и форму
// записи (`patches`, ключ `file`) знал каждый из трёх.
export function recordedPatches(state: State | null = readState()): Map<string, RecordedPatch> {
  return new Map((state?.patches ?? []).map(patch => [patch.file, patch]));
}

// Пишут запись двое: apply, когда патчи легли, и rebase, когда часть их снял.
// Время первого попадания в дерево сохраняется, пока файл патча не изменился, —
// иначе `appliedAt` означал бы «когда последний раз запускали».
//
// `keepAsRecorded` — патчи, чью прежнюю запись надо оставить дословно. Так
// сохраняется улика: apply отказался класть патч, потому что в дереве прежняя
// его версия, — и если бы запись при этом стёрлась вместе с ним, следующий
// `apply` уже ничего не знал бы и положил патч поверх. Отказ работал бы ровно
// один раз, а `bun install` зовут не по одному разу.
export function recordPatches(inTree: string[], keepAsRecorded: string[] = []): void {
  const previous = recordedPatches();
  const now = new Date().toISOString();

  const patches: RecordedPatch[] = inTree.map(file => {
    const parsed = parsePatchName(file);
    const raw = readFileSync(join(patchesDirectory(), file));
    const content = raw.toString('utf-8');
    const sha256 = hashPatchFile(raw);
    const bodySha256 = hashPatchBody(content);
    const before = previous.get(file);

    return {
      file,
      packageDir: parsed?.packageDir ?? '',
      version: parsed?.version ?? '',
      sha256,
      bodySha256,
      files: filesLeftBy(content),
      // Время первого попадания в дерево переживает правку заголовка: дерево от
      // неё не изменилось, значит и «применён тогда-то» остаётся верным.
      appliedAt: before !== undefined && sameChange(before, sha256, bodySha256) ? before.appliedAt : now,
    };
  });

  // Пересчитывать их нельзя: файл патча уже другой, и пересчёт записал бы его
  // хеш вместе с хешами файлов, которых этот патч в дерево не клал, — то есть
  // стёр бы ровно то, чем отказ и доказывается.
  for (const file of keepAsRecorded) {
    const before = previous.get(file);
    if (before !== undefined && !inTree.includes(file)) patches.push(before);
  }

  try {
    writeState(patches);
  } catch (error: any) {
    // Запись — удобство, а не условие работы. Если node_modules только для
    // чтения, патчи всё равно на месте, и врать про сбой не надо.
    console.log(`  ⚠️  could not write ${STATE_FILE}: ${error.message}`);
  }
}

// Одна и та же правка дерева: либо файл патча тот же побайтово, либо изменился
// только заголовок — тело осталось прежним.
function sameChange(before: RecordedPatch, sha256: string, bodySha256: string): boolean {
  if (before.sha256 === sha256) return true;
  return before.bodySha256 !== undefined && before.bodySha256 === bodySha256;
}

// Переименование патча дерева не касается: файл тот же, содержимое то же, и
// «применён тогда-то» остаётся верным ([[DEC-11]]). Поэтому запись переезжает
// вместе с именем, а не заводится заново и не остаётся под старым.
//
// Без этого `create --append`, превращающий одиночный патч в первый член
// последовательности, оставлял в записи имя, которого в patches/ уже нет:
// `status` называл его осиротевшим («no longer exist») и выходил с кодом 1 —
// то есть проверка в CI краснела после обычной работы.
export function renameRecordedPatch(from: string, to: string): void {
  const state = readState();
  if (state === null) return;

  // Запись под новым именем могла уже существовать: имя одиночного патча — это
  // и есть имя, которое получит схлопнутый. Оставляем одну, переехавшую.
  const patches = state.patches
    .map(patch => (patch.file === from ? {...patch, file: to} : patch))
    .filter((patch, at, all) => all.findIndex(other => other.file === patch.file) === at);

  try {
    writeState(patches);
  } catch (error: any) {
    // Как и в recordPatches: запись — удобство, а не условие работы.
    console.log(`  ⚠️  could not update ${STATE_FILE}: ${error.message}`);
  }
}

function writeState(patches: RecordedPatch[]): void {
  const state: State = {version: VERSION, patches};
  // В монорепо с поднятыми зависимостями своего node_modules у воркспейса может
  // не быть вовсе — измерено на bun 1.4.0 с `--linker hoisted`. Запись всё равно
  // принадлежит воркспейсу: она описывает его каталог patches/, а не дерево.
  ensureDir(join(STATE_FILE, '..'));
  atomicWrite(STATE_FILE, JSON.stringify(state, null, 2) + '\n');
}

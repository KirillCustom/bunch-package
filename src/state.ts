import {createHash} from 'crypto';
import {existsSync, readFileSync} from 'fs';
import {join} from 'path';
import {parsePatchName} from './patch-file';
import {PATCHES_DIR, atomicWrite} from './paths';

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
  appliedAt: string; // ISO-8601
}

export interface State {
  version: number;
  patches: RecordedPatch[];
}

export function hashPatchFile(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
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
export function recordPatches(inTree: string[]): void {
  const previous = recordedPatches();
  const now = new Date().toISOString();

  const patches: RecordedPatch[] = inTree.map(file => {
    const parsed = parsePatchName(file);
    const sha256 = hashPatchFile(join(PATCHES_DIR, file));
    const before = previous.get(file);

    return {
      file,
      packageDir: parsed?.packageDir ?? '',
      version: parsed?.version ?? '',
      sha256,
      appliedAt: before?.sha256 === sha256 ? before.appliedAt : now,
    };
  });

  try {
    writeState(patches);
  } catch (error: any) {
    // Запись — удобство, а не условие работы. Если node_modules только для
    // чтения, патчи всё равно на месте, и врать про сбой не надо.
    console.log(`  ⚠️  could not write ${STATE_FILE}: ${error.message}`);
  }
}

function writeState(patches: RecordedPatch[]): void {
  const state: State = {version: VERSION, patches};
  atomicWrite(STATE_FILE, JSON.stringify(state, null, 2) + '\n');
}

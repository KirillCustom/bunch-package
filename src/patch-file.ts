import {existsSync, readdirSync} from 'fs';
import {patchesDirectory} from './paths';

export interface Hunk {
  oldStart: number;
  newStart: number;
  lines: string[]; // с префиксами ' ', '+', '-'
  oldNoNewline: boolean;
  newNoNewline: boolean;
}

export interface PatchTarget {
  oldPath: string | null; // null — это /dev/null, то есть файл создаётся
  newPath: string | null; // null — файл удаляется
  hunks: Hunk[];
  oldMode: string | null; // '100644' / '100755' из git-заголовков
  newMode: string | null;
  // `new file mode` и `deleted file mode` — это не смена прав, а появление или
  // исчезновение файла. Без хунков они означают пустой файл: именно так git
  // записывает создание пустышки, и такие секции встречаются в реальных патчах.
  newFile: boolean;
  deletedFile: boolean;
  // git пишет `rename from` / `rename to` уже без префиксов a/ и b/ —
  // это пути от корня проекта, срезать у них первый компонент не нужно.
  renameFrom: string | null;
  renameTo: string | null;
}

export function parsePatch(patchContent: string): PatchTarget[] {
  const targets: PatchTarget[] = [];
  let target: PatchTarget | null = null;
  let hunk: Hunk | null = null;
  let oldLeft = 0;
  let newLeft = 0;
  let lastPrefix = '';
  // Секция закрывается первым же хунком: дальше `---` или `diff --git` начинают
  // следующий файл, а не дополняют текущий.
  let open = false;

  const asPath = (raw: string): string | null => (raw === '/dev/null' ? null : raw);

  // Секцию заводим через параметр, а не через изменяемую переменную из
  // замыкания: TypeScript не отслеживает присваивания внутри замыканий и считал
  // бы target вечно нулевым, теряя проверку типов там, где она нужнее всего.
  const ensureTarget = (existing: PatchTarget | null): PatchTarget => {
    if (open && existing !== null) return existing;

    const fresh: PatchTarget = {
      oldPath: null,
      newPath: null,
      hunks: [],
      oldMode: null,
      newMode: null,
      newFile: false,
      deletedFile: false,
      renameFrom: null,
      renameTo: null,
    };
    targets.push(fresh);
    open = true;
    hunk = null;
    return fresh;
  };

  for (const raw of patchContent.split('\n')) {
    // Патч может быть в CRLF, а файл — в LF. Структурные строки чистим от \r,
    // иначе он уезжает в путь из заголовка: файла с таким именем нет, и патч
    // «не ложится». В выводе \r возвращал курсор в начало строки, поэтому путь
    // в сообщении об ошибке выглядел пустым. Тело хунка не трогаем — там \r
    // может быть частью содержимого файла.
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;

    // `\ No newline at end of file` относится к предыдущей строке и может стоять
    // как внутри тела, так и сразу за ним — счётчики к этому моменту исчерпаны.
    if (line.startsWith('\\')) {
      if (hunk) {
        if (lastPrefix === '-') hunk.oldNoNewline = true;
        else if (lastPrefix === '+') hunk.newNoNewline = true;
        else {
          hunk.oldNoNewline = true;
          hunk.newNoNewline = true;
        }
      }
      continue;
    }

    if (hunk && (oldLeft > 0 || newLeft > 0)) {
      hunk.lines.push(raw);
      lastPrefix = raw.charAt(0);
      if (lastPrefix === '-') oldLeft--;
      else if (lastPrefix === '+') newLeft--;
      else {
        oldLeft--;
        newLeft--;
        lastPrefix = ' ';
      }
      continue;
    }

    // Секция со сменой одного лишь режима не содержит ---/+++ вовсе, поэтому
    // пути приходится брать отсюда. Заодно это то, что печатает git.
    const gitHeader = line.match(/^diff --git (\S+) (\S+)$/);
    if (gitHeader) {
      // `diff --git` начинает секцию всегда, даже если предыдущая ещё открыта:
      // просить нечего, поэтому и существующей секции здесь не передаём. Раньше
      // это делалось сбросом `open` снаружи — то есть признак «секция открыта»
      // жил в двух местах сразу.
      const fresh = (target = ensureTarget(null));
      fresh.oldPath = gitHeader[1];
      fresh.newPath = gitHeader[2];
      continue;
    }

    // Режимы приходят git-заголовками. patch-package читает ровно эти строки,
    // поэтому формат патча остаётся с ним совместимым.
    const renameLine = line.match(/^rename (from|to) (.+)$/);
    if (renameLine) {
      const current = (target = ensureTarget(target));
      if (renameLine[1] === 'from') current.renameFrom = renameLine[2];
      else current.renameTo = renameLine[2];
      continue;
    }

    const modeLine = line.match(/^(old|new|new file|deleted file) mode (\d+)$/);
    if (modeLine) {
      const current = (target = ensureTarget(target));
      if (modeLine[1] === 'deleted file') {
        current.oldMode = modeLine[2];
        current.deletedFile = true;
      } else if (modeLine[1] === 'old') {
        current.oldMode = modeLine[2];
      } else {
        current.newMode = modeLine[2];
        if (modeLine[1] === 'new file') current.newFile = true;
      }
      continue;
    }

    const head = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (head && target !== null) {
      oldLeft = head[2] === undefined ? 1 : Number(head[2]);
      newLeft = head[4] === undefined ? 1 : Number(head[4]);
      hunk = {
        oldStart: Number(head[1]),
        newStart: Number(head[3]),
        lines: [],
        oldNoNewline: false,
        newNoNewline: false,
      };
      target.hunks.push(hunk);
      open = false;
      continue;
    }

    const oldHeader = line.match(/^--- ([^\t]+)/);
    if (oldHeader) {
      const current = (target = ensureTarget(target));
      current.oldPath = asPath(oldHeader[1]);
      continue;
    }

    const newHeader = line.match(/^\+\+\+ ([^\t]+)/);
    if (newHeader && target !== null) {
      target.newPath = asPath(newHeader[1]);
      continue;
    }
  }

  // Секция без хунков осмысленна, если несёт смену режима.
  return targets.filter(
    t => t.hunks.length > 0 || t.newMode !== null || t.oldMode !== null || t.renameTo !== null,
  );
}

// Откат патча — это применение перевёрнутого патча, а не отдельный применятель.
// Так весь разбор случаев (создание, удаление, переименование, режимы, файл без
// перевода строки в конце) остаётся один на оба направления — тот самый, что
// выверен корпусом. Второй экземпляр той же логики разошёлся бы с первым.
export function invertTarget(target: PatchTarget): PatchTarget {
  // Встречаются патчи, у которых стороны названы разными файлами без заголовков
  // rename: так выглядит `diff bootstrap.js.bak bootstrap.js`. Правят они всё
  // равно один файл — тот, что назван новой стороной, потому что именно его
  // берёт planTarget. Перестановка путей увела бы откат в файл, которого нет:
  // на корпусе это ровно тот случай, где дерево не возвращалось к эталону.
  const oneFile = target.renameFrom === null && target.oldPath !== null && target.newPath !== null;

  return {
    oldPath: target.newPath,
    newPath: oneFile ? target.newPath : target.oldPath,
    hunks: target.hunks.map(invertHunk),
    oldMode: target.newMode,
    newMode: target.oldMode,
    // `new file mode` наоборот означает, что файл исчезает, и обратно.
    newFile: target.deletedFile,
    deletedFile: target.newFile,
    renameFrom: target.renameTo,
    renameTo: target.renameFrom,
  };
}

function invertHunk(hunk: Hunk): Hunk {
  return {
    oldStart: hunk.newStart,
    newStart: hunk.oldStart,
    lines: hunk.lines.map(line => {
      const prefix = line.charAt(0);
      if (prefix === '+') return `-${line.slice(1)}`;
      if (prefix === '-') return `+${line.slice(1)}`;
      return line; // контекст остаётся контекстом
    }),
    oldNoNewline: hunk.newNoNewline,
    newNoNewline: hunk.oldNoNewline,
  };
}

// Одна сторона хунка: для старой отбрасываем добавленные строки, для новой — удалённые.
// Пустая строка — это контекст, у которого срезали хвостовой пробел.
export function sideLines(hunk: Hunk, side: 'old' | 'new'): string[] {
  const drop = side === 'old' ? '+' : '-';
  return hunk.lines.filter(line => !line.startsWith(drop)).map(line => line.slice(1));
}

// Пуста ли сторона — спрашивают чаще, чем строят саму сторону: пустая старая
// означает создание файла, пустая новая — удаление. Спрашивать это через
// sideLines(...).length значит собрать список строк ради того, чтобы узнать,
// что он пуст.
export function sideIsEmpty(hunk: Hunk, side: 'old' | 'new'): boolean {
  const drop = side === 'old' ? '+' : '-';
  return hunk.lines.every(line => line.startsWith(drop));
}

// Имя файла патча несёт пакет, версию и — для последовательности — номер и
// метку: `react-native+0.72.0+002+fix-touchable.patch`. Такой формат у
// patch-package, и повторять его стоит: патчи людей и инструментов ходят
// между проектами.
//
// Версия сама может содержать `+` (метаданные сборки), поэтому разбираем справа:
// номер — ровно три цифры, метка без `+`, остальное слева — пакет и версия.
export interface PatchName {
  packageDir: string; // как каталог в node_modules: `@scope/pkg`, `outer/node_modules/inner`
  version: string;
  sequence: number; // 0 — одиночный патч вне последовательности
  label: string;
  // `ms+2.1.2.dev.patch` — патч пакета, которого в production нет вовсе. Метка
  // стоит в имени файла, а не в отдельном списке: так её видно там же, где и
  // сам патч, и так же её отмечает patch-package.
  devOnly: boolean;
}

const DEV_SUFFIX = '.dev.patch';

export function parsePatchName(file: string): PatchName | null {
  if (!file.endsWith('.patch')) return null;

  const devOnly = file.endsWith(DEV_SUFFIX);
  const base = file.slice(0, -(devOnly ? DEV_SUFFIX.length : '.patch'.length));

  const sequenced = base.match(/^(.+)\+(\d{3})\+([^+]+)$/);
  const head = sequenced ? sequenced[1] : base;
  const separator = head.lastIndexOf('+');
  if (separator === -1) return null;

  return {
    packageDir: decodePackageDir(head.slice(0, separator)),
    version: head.slice(separator + 1),
    sequence: sequenced ? Number(sequenced[2]) : 0,
    label: sequenced ? sequenced[3] : '',
    devOnly,
  };
}

// Вложенную зависимость patch-package записывает через двойной плюс:
// `foo++bar+1.0.0.patch` — это `node_modules/foo/node_modules/bar`. Слэш внутри
// имени со скоупом при этом кодируется одиночным плюсом, поэтому разделители
// разбираем до того, как трогать имена.
const NESTED = '/node_modules/';

function decodePackageDir(head: string): string {
  return head.split('++').map(part => part.replace(/\+/g, '/')).join(NESTED);
}

function encodePackageDir(packageDir: string): string {
  return packageDir.split(NESTED).map(part => part.replace(/\//g, '+')).join('++');
}

// Обратная к parsePatchName: формат имени описан выше, и собирать его руками в
// каждой команде значило бы держать разбор и сборку в разных файлах — они бы
// разъехались молча, а признаком стал бы патч, которого никто больше не узнаёт.
export function formatPatchName(parts: {
  packageDir: string;
  version: string;
  sequence?: number;
  label?: string;
  devOnly?: boolean;
}): string {
  const suffix = parts.devOnly ? DEV_SUFFIX : '.patch';
  const head = `${encodePackageDir(parts.packageDir)}+${parts.version}`;
  if (!parts.sequence || parts.label === undefined || parts.label === '') return `${head}${suffix}`;
  return `${head}+${String(parts.sequence).padStart(3, '0')}+${parts.label}${suffix}`;
}

// Патчи одного пакета: к какому каталогу патч ложится, сказано в его имени, и
// по имени же они собираются в набор. Спрашивают трое — apply, чтобы сказать,
// что один из них написан не для установленной версии; create, чтобы сказать это
// в ту минуту, когда второй файл и появляется; retarget, чтобы объяснить, за
// какой набор он не берётся. Фильтр был написан у каждого свой.
export function patchesOfPackage(files: string[], packageDir: string): string[] {
  return files.filter(file => parsePatchName(file)?.packageDir === packageDir);
}

// Под каким именем лежат патчи этого пакета. Начиная с 1.17.0 `create` называет
// файл по каталогу в node_modules — так же, как это делает patch-package
// (проверено запуском на `mynum@npm:is-number@7.0.0`: он пишет
// `mynum+7.0.0.patch`). Прежние версии брали имя из манифеста, и такие файлы
// продолжают читаться: пишем по-новому, понимаем оба.
//
// Порядок важен: каталог спрашивается первым. Пакет, установленный и напрямую,
// и через алиас, даёт два каталога с одним manifest.name — начни мы с имени из
// манифеста, набор одного каталога прихватил бы патчи соседнего.
export function patchNameKey(packageDir: string, manifestName: string, files: string[] = listPatchFiles()): string {
  if (manifestName === packageDir) return packageDir;
  if (patchesOfPackage(files, packageDir).length > 0) return packageDir;
  return patchesOfPackage(files, manifestName).length > 0 ? manifestName : packageDir;
}

// Все команды перечисляют patches/ одинаково, и все обязаны получить один и тот
// же порядок: патчи последовательности строятся друг на друге. Отсутствующий
// каталог — это просто пустой список; что о нём сказать, решает вызывающий.
export function listPatchFiles(): string[] {
  if (!existsSync(patchesDirectory())) return [];
  return orderPatchFiles(readdirSync(patchesDirectory()).filter(file => file.endsWith('.patch')));
}

// Патчи одной последовательности строятся друг на друге, как коммиты, поэтому
// порядок обязан быть детерминированным. readdirSync его не даёт: он вернул
// файлы в порядке создания, а не по имени.
export function orderPatchFiles(files: string[]): string[] {
  // Имя разбирается один раз на файл: компаратор зовут O(n log n) раз, и разбор
  // регулярками шёл столько же вместо числа самих файлов.
  const names = new Map(files.map(file => [file, parsePatchName(file)]));

  return [...files].sort((a, b) => {
    const left = names.get(a) ?? null;
    const right = names.get(b) ?? null;
    // Номера сравниваем, только когда они различаются: при равных `sequence`
    // разность давала ноль, сортировка стабильна — и порядок оставался тем, в
    // каком файлы отдал readdirSync. То есть ровно тем, от которого эта функция
    // и заведена уходить. Два патча с одним номером — вещь рукотворная, но
    // руками имена и правят.
    if (left && right && left.packageDir === right.packageDir && left.version === right.version
        && left.sequence !== right.sequence) {
      return left.sequence - right.sequence;
    }
    return a.localeCompare(b);
  });
}

// Ниже — собственное применение унифицированных диффов. Раньше эту работу делал
// системный patch(1), и половина проблем росла именно оттуда: на Linux это GNU,
// на macOS — Apple, у них расходятся коды возврата, тексты сообщений и даже
// защита от выхода за корень проекта. Плюс patch применяет файлы по одному,
// поэтому провал на середине оставлял дерево наполовину пропатченным и сыпал
// .rej/.orig. Здесь ничего не пишется на диск, пока не сойдётся весь патч.

// Всё, что стоит перед первой структурной строкой, — заголовок патча: место,
// где написано, зачем он существует. Имя файла говорит только про пакет и
// версию, а причина живёт в голове того, кто патч сделал, — и через полгода
// никто не скажет, можно ли его выбрасывать.
//
// Формат это терпит, и терпит доказанно: тот же патч с четырьмя видами
// заголовка (свободный текст, строки с `#`, git-стиль `From:`/`Subject:`)
// применяется patch-package 8.0.1 и нами в побайтово одинаковые деревья.
// Разборщик заголовок и так не замечает — здесь он нужен затем, чтобы `create`
// и `retarget` не выбрасывали его при перезаписи файла.
const STRUCTURAL =
  /^(diff --git |--- |\+\+\+ |@@ |Index: |index |old mode |new mode |new file mode |deleted file mode |rename from |rename to |similarity index |Binary files )/;

// Строка заголовка, начинающаяся так, была бы прочитана как начало секции.
// Спрашивает разбор аргументов: `--why "--- сломано"` иначе превратил бы патч
// в нечитаемый, и узнали бы об этом на `apply`, а не на `create`.
export function looksStructural(line: string): boolean {
  return STRUCTURAL.test(line);
}

export function splitPatchHeader(content: string): {header: string; body: string} {
  const lines = content.split('\n');
  let at = 0;
  while (at < lines.length && !STRUCTURAL.test(lines[at])) at++;

  // Ни одной структурной строки — значит это не патч, а что-то другое. Считать
  // его целиком заголовком нельзя: склейка header + body потеряла бы содержимое.
  if (at === 0 || at === lines.length) return {header: '', body: content};

  return {header: lines.slice(0, at).join('\n') + '\n', body: lines.slice(at).join('\n')};
}

export interface PatchHeaderFields {
  why?: string;
  upstream?: string;
}

const FIELD = /^(Why|Upstream):\s*(.*)$/i;

export function patchHeaderField(header: string, key: 'Why' | 'Upstream'): string | null {
  for (const line of header.split('\n')) {
    const match = FIELD.exec(line);
    if (match !== null && match[1].toLowerCase() === key.toLowerCase()) return match[2].trim();
  }
  return null;
}

// Первая содержательная строка заголовка — то, что показывает `status`.
export function patchHeaderSummary(header: string): string | null {
  const why = patchHeaderField(header, 'Why');
  if (why !== null && why !== '') return why;

  const first = header.split('\n').find(line => line.trim() !== '');
  return first === undefined ? null : first.trim();
}

// Известные поля переписываются, всё остальное остаётся как было и в прежнем
// порядке: заголовок мог быть написан руками, и терять чужие строки при
// обновлении патча — то же самое, что терять сам заголовок.
export function updatePatchHeader(header: string, fields: PatchHeaderFields): string {
  const why = fields.why ?? patchHeaderField(header, 'Why') ?? undefined;
  const upstream = fields.upstream ?? patchHeaderField(header, 'Upstream') ?? undefined;

  const rest = header
    .split('\n')
    .filter(line => FIELD.exec(line) === null);
  while (rest.length > 0 && rest[0].trim() === '') rest.shift();
  while (rest.length > 0 && rest[rest.length - 1].trim() === '') rest.pop();

  const lines = [
    ...(why === undefined ? [] : [`Why: ${why}`]),
    ...(upstream === undefined ? [] : [`Upstream: ${upstream}`]),
    ...rest,
  ];

  // Пустая строка отделяет заголовок от первой секции — и она же делает
  // повторный `create` с тем же заголовком побайтово тем же файлом.
  return lines.length === 0 ? '' : lines.join('\n') + '\n\n';
}

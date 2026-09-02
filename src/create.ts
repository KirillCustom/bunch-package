import {execFileSync} from 'child_process';
import {createHash} from 'crypto';
import {existsSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, writeFileSync} from 'fs';
import {homedir} from 'os';
import {join, resolve, sep} from 'path';
import {bunAlsoPatches} from './foreign';
import {PathFilters, pathAllowed} from './options';
import {patchesDirectory, TEMP_WRITE_SUFFIX, ensureDir, isExecutable, realPathOutsideProject} from './paths';
import {PatchHeaderFields, splitPatchHeader, updatePatchHeader} from './patch-file';
import {planSequence, replayPatches, SequencePlan} from './sequence';
import {renameRecordedPatch} from './state';

// diff матчит --exclude по имени файла, а не по пути, поэтому здесь только то,
// что артефактно на любой глубине. Каталоги сборки сюда не входят: `build` у
// множества пакетов — это каталог с распространяемым кодом. Ими занимается
// isBuildArtifact() уже после диффа, по относительному пути.
const EXCLUDE_PATTERNS = [
  'node_modules',
  '.git',
  '.DS_Store',
  // Следы неудачного apply — иначе они уезжают в следующий патч
  '*.rej',
  '*.orig',
  `*${TEMP_WRITE_SUFFIX}*`,
  // patch-package кладёт свою запись о состоянии внутрь каталога пакета —
  // проверено запуском на последовательности. В проекте, пришедшем оттуда,
  // такой файл лежит в node_modules и без этой строки уехал бы в наш патч.
  '.patch-package.json',
  // Бинарные файлы Android
  '*.so',
  '*.jar',
  '*.aar',
  '*.class',
  '*.dex',
  '*.apk',
  // Бинарные файлы iOS
  '*.a',
  '*.framework',
  '*.xcframework',
  '*.dylib',
  // Медиа файлы
  '*.png',
  '*.jpg',
  '*.jpeg',
  '*.gif',
  '*.webp',
  // Шрифты
  '*.ttf',
  '*.otf',
  '*.woff',
  '*.woff2',
];

// Потолок вывода diff. Больше него — это уже не патч, а перенос дерева, и
// писать усечённый патч нельзя ни при каких условиях.
const DIFF_MAX_BUFFER = 50 * 1024 * 1024;

// Эти имена не бывают исходниками ни на какой глубине.
const ARTIFACT_SEGMENTS = ['.gradle', '.cxx', '.transforms', 'DerivedData', 'Pods'];

// А `build` бывает: под платформенным каталогом это артефакт, в корне пакета —
// обычно его собранный JavaScript. Поэтому только с якорем.
const ARTIFACT_PREFIXES = ['android/build', 'ios/build', 'macos/build', 'windows/build'];

function isBuildArtifact(relativePath: string): boolean {
  if (relativePath.split('/').some(segment => ARTIFACT_SEGMENTS.includes(segment))) {
    return true;
  }
  return ARTIFACT_PREFIXES.some(
    prefix => relativePath === prefix || relativePath.startsWith(`${prefix}/`),
  );
}

// Смена одного лишь режима в дифф не попадает вовсе, поэтому оба дерева
// приходится обойти самим. Как и git, из всех прав отслеживаем только бит
// исполнения: полные режимы сравнивать нельзя — у распакованного эталона и у
// node_modules разный umask.
//
// Тем же обходом собираются симлинки. Их diff не переносит ни в каком виде:
// разницу он либо печатает строкой без хунка, либо — на GNU — не переживает
// вовсе. Значит, заметить её можно только самим.
export interface TreeScan {
  executable: Map<string, boolean>; // обычные файлы → бит исполнения
  links: Map<string, string>; // симлинки → цель ссылки
}

export function scanTree(root: string, prefix = '', into?: TreeScan): TreeScan {
  const scan: TreeScan = into ?? {executable: new Map(), links: new Map()};
  if (!existsSync(root)) return scan;

  for (const entry of readdirSync(root, {withFileTypes: true})) {
    const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;

    // Симлинк на каталог сюда же: внутрь мы не идём, потому что и diff с
    // --no-dereference внутрь не идёт.
    if (entry.isSymbolicLink()) {
      scan.links.set(relative, readlinkSync(join(root, entry.name)));
      continue;
    }

    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      if (isBuildArtifact(relative)) continue;
      scanTree(join(root, entry.name), relative, scan);
      continue;
    }

    if (!entry.isFile()) continue;
    scan.executable.set(relative, isExecutable(statSync(join(root, entry.name)).mode));
  }

  return scan;
}

// Что стало с симлинком между эталоном и node_modules. `missingFrom` называет
// дерево, где пути нет вовсе: именно на этом сочетании GNU diff отказывает.
export interface LinkDifference {
  relativePath: string;
  change: string;
  missingFrom: 'clean' | 'modified' | null;
}

export function findLinkDifferences(clean: TreeScan, modified: TreeScan): LinkDifference[] {
  const differences: LinkDifference[] = [];
  const paths = [...new Set([...clean.links.keys(), ...modified.links.keys()])].sort();

  for (const relativePath of paths) {
    const before = clean.links.get(relativePath);
    const after = modified.links.get(relativePath);

    if (before !== undefined && after !== undefined) {
      if (before !== after) {
        differences.push({relativePath, change: `now points at ${after}`, missingFrom: null});
      }
      continue;
    }

    if (after !== undefined) {
      differences.push(
        clean.executable.has(relativePath)
          ? {relativePath, change: 'a regular file became a symlink', missingFrom: null}
          : {relativePath, change: 'added', missingFrom: 'clean'},
      );
      continue;
    }

    differences.push(
      modified.executable.has(relativePath)
        ? {relativePath, change: 'a symlink became a regular file', missingFrom: null}
        : {relativePath, change: 'removed', missingFrom: 'modified'},
    );
  }

  return differences;
}

export interface DiffSection {
  relativePath: string;
  body: string[];
}

// Секции режем по заголовкам, а не по строке с командой diff, и идём с учётом
// границ хунков — строка кода `--- /foo` внутри тела не должна сойти за заголовок.
//
// Тело хунка мы переносим дословно, а заголовки собираем заново из путей. Это
// принципиально: прежняя нормализация была заменой подстроки по всему тексту,
// поэтому путь проекта, встретившийся внутри файла, молча портился.
function splitDiffSections(diffOutput: string, cleanRoot: string, modifiedRoot: string): DiffSection[] {
  const sections: DiffSection[] = [];
  let current: DiffSection | null = null;
  let oldLeft = 0;
  let newLeft = 0;

  const relativize = (path: string): string | null => {
    for (const root of [modifiedRoot, cleanRoot]) {
      if (path.startsWith(`${root}/`)) return path.slice(root.length + 1);
    }
    return null;
  };

  for (const line of diffOutput.split('\n')) {
    // `\ No newline at end of file` идёт после последней строки хунка, когда
    // счётчики уже исчерпаны, поэтому ловим его раньше проверки на тело.
    // Строка кода так начинаться не может: в теле у неё всегда есть префикс.
    if (line.startsWith('\\') && current !== null && current.body.length > 0) {
      current.body.push(line);
      continue;
    }

    if (oldLeft > 0 || newLeft > 0) {
      current?.body.push(line);
      if (line.startsWith('-')) oldLeft--;
      else if (line.startsWith('+')) newLeft--;
      else {
        oldLeft--;
        newLeft--;
      }
      continue;
    }

    const hunk = line.match(/^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/);
    if (hunk) {
      oldLeft = hunk[1] === undefined ? 1 : Number(hunk[1]);
      newLeft = hunk[2] === undefined ? 1 : Number(hunk[2]);
      current?.body.push(line);
      continue;
    }

    const header = line.match(/^(?:---|\+\+\+) ([^\t]+)/);
    if (header) {
      const relativePath = relativize(header[1]);
      if (relativePath !== null && (current === null || current.relativePath !== relativePath)) {
        current = {relativePath, body: []};
        sections.push(current);
      }
    }
  }

  return sections.filter(section => section.body.length > 0);
}

export function validatePackageName(name: string): void {
  // Вложенная зависимость называется путём под node_modules:
  // `foo/node_modules/bar`. Каждое звено проверяем как обычное имя пакета.
  if (name.split('/node_modules/').some(segment => !/^(@[\w.-]+\/)?[\w.-]+$/.test(segment))) {
    throw new Error(`Invalid package name: ${name}`);
  }
  // Регулярка выше пропускает `.` и `..`: точка входит в \w.-. С таким именем
  // create диффал весь проект и складывал его файлы, включая неотслеживаемые,
  // в patches/.
  if (name.split('/').some(segment => segment === '.' || segment === '..')) {
    throw new Error(`Invalid package name: ${name}`);
  }
}

// name и version приходят из чужого package.json и попадают прямо в путь записи.
function validateManifestField(field: string, value: unknown): string {
  if (typeof value !== 'string' || !/^[\w.@/+-]+$/.test(value) || value.split(/[/\\]/).some(s => s === '.' || s === '..')) {
    throw new Error(`Package manifest has an unusable ${field}: ${String(value)}`);
  }
  return value;
}

// Проверяем наличие diff до всякой работы: иначе отказ случался уже после
// скачивания эталона, впустую потратив сеть и время. Отличаем «бинарника нет»
// от «ответил странно»: ENOENT означает первое, всё остальное — что diff на
// месте, и мешать ему не нужно.
export function requireDiff(): void {
  try {
    execFileSync('diff', ['--version'], {stdio: 'pipe'});
  } catch (error: any) {
    if (error.code !== 'ENOENT') return;
    throw new Error(
      process.platform === 'win32'
        ? '`create` needs the `diff` command, which is not on PATH. It ships with Git for Windows — install that, or add its usr\\bin directory to PATH. `apply` does not need it.'
        : '`create` needs the `diff` command, which is not on PATH. Install diffutils. `apply` does not need it.',
    );
  }
}

// Apple patch писал диагностику в stdout, GNU — в stderr, и привычка читать оба
// потока осталась полезной для bun и npm. Если молчат оба, берём сообщение самой
// ошибки: иначе пользователь видит пустую строку вместо причины.
//
// Функция была потеряна при одном из рефакторингов, и запасной путь через npm
// из-за этого падал с ReferenceError вместо того, чтобы отработать.
function firstDiagnosticLine(error: any): string {
  const streams = nonEmptyLines(`${error.stderr?.toString() ?? ''}\n${error.stdout?.toString() ?? ''}`);
  return streams[0] ?? (error.message ? String(error.message).split('\n')[0].trim() : '');
}

// Чужой вывод разбирают четверо — bun, npm, tar и diff, — и всем нужно одно:
// строки, в которых после обрезки что-то осталось. Пустые строки в диагностике
// есть всегда, и каждый раз выписывать split/trim/filter значило четыре шанса
// забыть одно из трёх.
function nonEmptyLines(text: string): string[] {
  return text.split('\n').map(line => line.trim()).filter(Boolean);
}

// Установка эталона ходит в сеть, и висеть там вечно она не должна. Шестидесяти
// секунд хватает пакету любого разумного размера — но не на медленном канале, а
// упереться в предел там значит остаться без create вовсе. Отсюда переменная
// окружения: тупик должен иметь выход.
const FETCH_TIMEOUT_MS = 60_000;

// Кеш эталона у нас свой, не бунов. bun раскладывает пакеты из общего кеша
// hardlink'ами — на Linux это умолчание, проверено на 1.0.36: у файла в
// node_modules две ссылки, и вторая ведёт в кеш. Правка такого файла меняет
// саму запись кеша, «чистая» установка приезжает уже изменённой, а diff
// сравнивает файл сам с собой и отвечает «No changes detected».
//
// Но выбрасывать этот кеш вместе с временным каталогом незачем, а раньше
// именно так и было: каждый `create` и каждый `retarget` качали пакет заново.
// Измерено на typescript@5.4.5 (31 МБ): установка эталона 3,44 с против 66 мс,
// когда кеш уже тёплый.
function pristineCacheDir(): string {
  const override = process.env.BUNCH_PRISTINE_CACHE;
  if (override !== undefined && override !== '') return override;

  const base =
    process.platform === 'win32'
      ? process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local')
      : process.env.XDG_CACHE_HOME ?? join(homedir(), '.cache');

  return join(base, 'bunch-package', 'pristine');
}

function fetchTimeoutMs(): number {
  const raw = process.env.BUNCH_FETCH_TIMEOUT;
  if (raw === undefined || raw === '') return FETCH_TIMEOUT_MS;

  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new Error(`BUNCH_FETCH_TIMEOUT must be a positive number of seconds, got: ${raw}`);
  }
  return Math.round(seconds * 1000);
}

// При таймауте bun не отдаёт ни stdout, ни stderr — измерено: процесс убивается
// SIGTERM, потоки приходят пустыми. Поэтому firstDiagnosticLine() отдал бы
// `spawnSync bun ETIMEDOUT`, из чего пользователю не понять ни того, что предел
// наш, ни того, что его можно поднять.
function describeFetchFailure(error: any, timeoutMs: number): string {
  if (error.code === 'ETIMEDOUT') {
    return `timed out after ${Math.round(timeoutMs / 1000)}s (raise BUNCH_FETCH_TIMEOUT to wait longer)`;
  }
  return firstDiagnosticLine(error) || error.message;
}

interface Manifest {
  name: string;
  version: string;
}

export function readManifest(packagePath: string): Manifest {
  const packageJson = JSON.parse(readFileSync(join(packagePath, 'package.json'), 'utf-8'));
  return {
    name: validateManifestField('name', packageJson.name),
    version: validateManifestField('version', packageJson.version),
  };
}

// Эталон нельзя ставить обычным `bun add`: bun раскладывает пакеты hardlink'ами,
// поэтому файл в node_modules и запись в глобальном кеше — один инод. Правка
// файла меняет кеш, «чистая» установка приезжает уже изменённой, и diff
// сравнивает файл сам с собой, отдавая «No changes detected». На Linux это
// поведение по умолчанию.
//
// Лечится своим кешем: BUN_INSTALL_CACHE_DIR уводит установку в каталог, до
// которого редактору пользователя не дотянуться, — см. pristineCacheDir().
function fetchPristine(name: string, version: string, tempDir: string): string {
  writeFileSync(
    join(tempDir, 'package.json'),
    JSON.stringify({name: 'temp', version: '1.0.0'}, null, 2),
  );

  const failures: string[] = [];
  const timeout = fetchTimeoutMs();

  const cache = pristineCacheDir();

  try {
    ensureDir(cache);
    // --backend=copyfile: из своего кеша тоже незачем тянуть hardlink, потому
    // что в эталон мы пишем — им доводятся предыдущие патчи последовательности.
    // Сейчас все записи ссылку рвут (atomicWrite пишет рядом и переставляет),
    // но это невидимый инвариант, а копия снимает вопрос вовсе: у файла эталона
    // одна ссылка. Стоит это 66 мс против 27 на 31 МБ, и флаг есть с bun 1.0.
    execFileSync('bun', ['add', '--no-save', '--backend=copyfile', `${name}@${version}`], {
      cwd: tempDir,
      stdio: 'pipe',
      timeout,
      env: {...process.env, BUN_INSTALL_CACHE_DIR: cache},
    });
    // Имя каталога в node_modules не обязано совпадать с именем пакета: при
    // установке через алиас (`"mynum": "npm:is-number@7.0.0"`) они разные.
    // Путь к эталону строим по имени из манифеста, а не по аргументу команды.
    return join(tempDir, 'node_modules', name);
  } catch (error: any) {
    failures.push(`bun: ${describeFetchFailure(error, timeout)}`);
  }

  // Запасной путь — тарбол из реестра. Он тоже мимо кеша bun, но требует npm,
  // которого нет, например, в официальном образе oven/bun.
  try {
    const packed = execFileSync('npm', ['pack', '--silent', '--pack-destination', tempDir, `${name}@${version}`], {
      cwd: tempDir,
      encoding: 'utf-8',
      timeout,
    });
    const printed = nonEmptyLines(packed).pop();
    if (!printed) throw new Error('npm pack printed no tarball name');
    execFileSync('tar', ['-xzf', join(tempDir, printed), '-C', tempDir], {stdio: 'pipe', timeout});
    return join(tempDir, 'package'); // тарболы npm всегда распаковываются сюда
  } catch (npmError: any) {
    failures.push(`npm: ${describeFetchFailure(npmError, timeout)}`);
    throw new Error(`Could not fetch a pristine ${name}@${version}:\n   ${failures.join('\n   ')}`);
  }
}

// GNU diff, в отличие от Apple, не переживает `-N`, когда с одной стороны
// симлинк, а с другой нет ничего: он печатает `diff: <путь>: No such file or
// directory` и выходит с кодом 2 — тем же, которым сообщает о настоящем сбое.
// Из-за этого один добавленный симлинк отменял весь патч, включая правки,
// которые переносятся прекрасно. Код 2 принимаем, только если каждая строка
// диагностики говорит ровно про такой симлинк, и ни про что больше.
function onlyMissingLinks(stderr: string, tolerated: Set<string>): boolean {
  const lines = nonEmptyLines(stderr);
  if (lines.length === 0) return false;

  return lines.every(line => {
    const match = line.match(/^diff: (.+): No such file or directory$/);
    return match !== null && tolerated.has(match[1]);
  });
}

// Эталон нужен и `create`, и `retarget`, а вместе с ним — временный каталог,
// который надо убрать в любом случае. Каталог уникален по pid: два прогона в
// одном проекте иначе работали бы в одном и том же `.bunch-patch-tmp`, и
// уборка одного сносила бы дерево другого.
export function withPristine<T>(name: string, version: string, run: (pristine: string, tempDir: string) => T): T {
  const tempDir = join(process.cwd(), `.bunch-patch-tmp-${process.pid}`);

  try {
    rmSync(tempDir, {force: true, recursive: true});
    ensureDir(tempDir);

    console.log(`📥 Fetching pristine ${name}@${version}...`);
    const pristine = fetchPristine(name, version, tempDir);

    // Без этой проверки отсутствующий эталон не заметен: diff -N трактует
    // недостающую сторону как пустую и выдаёт патч «добавить все файлы».
    if (!existsSync(pristine)) {
      throw new Error(`Pristine copy of ${name}@${version} did not land at ${pristine}`);
    }

    return run(pristine, tempDir);
  } finally {
    rmSync(tempDir, {force: true, recursive: true});
  }
}

export function runDiff(
  cleanPackagePath: string,
  packagePath: string,
  name: string,
  version: string,
  toleratedMissing: Set<string> = new Set(),
  maxBuffer: number = DIFF_MAX_BUFFER,
): string {
  // Без шелла: раньше это была строка, в которую подставлялся process.cwd(),
  // и `|| true` превращал любой сбой diff в успокаивающее «нет изменений».
  const diffArgs = [
    '-Naur',
    ...EXCLUDE_PATTERNS.map(pattern => `--exclude=${pattern}`),
    '--no-dereference',
    cleanPackagePath,
    packagePath,
  ];

  let rawBuffer: Buffer;
  try {
    // stderr забираем себе, а не отдаём наружу: про симлинки diff пишет туда
    // строку, которую пользователю читать незачем — про них он сейчас услышит
    // понятным текстом. Настоящий сбой мы всё равно печатаем сами, из catch.
    rawBuffer = execFileSync('diff', diffArgs, {maxBuffer, stdio: ['ignore', 'pipe', 'pipe']});
  } catch (error: any) {
    // Вывод больше maxBuffer: bun (как и node) убивает diff сигналом и отдаёт
    // усечённый stdout со status = null. Проверено — усечение молчаливое, и
    // если принять его за нормальный вывод, на диск ляжет обрезанный патч.
    // Отсюда отдельная ветка: сказать вслух и назвать причину.
    if (error.code === 'ENOBUFS') {
      throw new Error(
        `The diff for ${name}@${version} is larger than ${Math.round(maxBuffer / 1024 / 1024)} MB. ` +
          `Writing a truncated patch would be worse than writing none, so nothing was written. ` +
          `Usually this means generated or build output is being compared — patch a smaller part of the package.`,
      );
    }

    // diff: 0 — совпало, 1 — есть различия, 2 и выше — сбой.
    const stderr = error.stderr?.toString() ?? '';
    if (error.status !== 1 && !(error.status === 2 && onlyMissingLinks(stderr, toleratedMissing))) {
      const reason = nonEmptyLines(stderr || error.message || '')[0];
      throw new Error(`diff failed: ${reason}`);
    }
    rawBuffer = error.stdout ?? Buffer.alloc(0);
  }

  // Читать вывод как utf-8 без проверки нельзя: каждый неверный байт
  // превращался в U+FFFD, патч уезжал испорченным, а apply молча записывал не
  // те байты. Лучше отказаться вслух, чем тихо испортить файл. Декодер с
  // fatal: true отвечает на этот вопрос тем же проходом, которым и декодирует,
  // — без второй копии диффа размером до DIFF_MAX_BUFFER.
  try {
    return new TextDecoder('utf-8', {fatal: true}).decode(rawBuffer);
  } catch {
    throw new Error(
      `The diff for ${name}@${version} is not valid UTF-8 — some changed file is binary ` +
        `or in another encoding. Writing this patch would corrupt it.`,
    );
  }
}

// Все три отчёта ниже устроены одинаково: заголовок, первые пять строк и
// «...and N more». Предел живёт здесь, в одном месте.
function reportList<T>(header: string, items: T[], render: (item: T) => string, footer?: string): void {
  if (items.length === 0) return;

  console.log(header);
  for (const item of items.slice(0, 5)) console.log(`   ${render(item)}`);
  if (items.length > 5) console.log(`   ...and ${items.length - 5} more`);
  if (footer !== undefined) console.log(footer);
}

// Двоичные файлы diff в патч не включает, печатая одну строку. Без этого
// сообщения их изменение просто пропадало.
function reportBinaryFiles(rawPatch: string, packagePath: string): void {
  const notices = rawPatch
    .split('\n')
    .filter(line => line.startsWith('Binary files ') && line.endsWith(' differ'));

  reportList(`⚠️  ${notices.length} binary file(s) differ and cannot be patched:`, notices, notice => {
    const paths = notice.slice('Binary files '.length, -' differ'.length);
    const modified = paths.split(' and ').pop() ?? paths;
    return modified.startsWith(packagePath + sep) ? modified.slice(packagePath.length + 1) : modified;
  });
}

// Симлинк не переносится патчем: формат возит содержимое файлов, а не ссылки.
// Молчать об этом нельзя — правку было бы не отличить от «ничего не менялось».
function reportLinkDifferences(differences: LinkDifference[]): void {
  reportList(
    `⚠️  ${differences.length} symbolic link(s) differ and cannot be patched:`,
    differences,
    difference => `${difference.relativePath} — ${difference.change}`,
    `   A patch carries file contents, not links: these changes are not in it.`,
  );
}

// Отсеянное фильтрами называем поимённо: человек сам их задал, но «ничего не
// изменилось» после --include с опечаткой выглядит как отсутствие правок.
function reportFiltered(filtered: DiffSection[]): void {
  reportList(
    `⏭  ${filtered.length} path(s) left out by --include/--exclude:`,
    filtered,
    section => section.relativePath,
  );
}

function reportSkipped(skipped: DiffSection[]): void {
  reportList(
    `⏭  Skipped ${skipped.length} build-artifact path(s):`,
    skipped,
    section => section.relativePath,
  );
}

// Файлы, у которых изменился только бит исполнения: в диффе их нет вовсе.
function findModeOnlyChanges(
  cleanBits: Map<string, boolean>,
  modifiedBits: Map<string, boolean>,
  changed: Set<string>,
): string[] {
  return [...modifiedBits.entries()]
    .filter(([relativePath, executable]) => {
      if (changed.has(relativePath)) return false;
      const before = cleanBits.get(relativePath);
      return before !== undefined && before !== executable;
    })
    .map(([relativePath]) => relativePath)
    .sort();
}

// Заголовки собираем заново из путей, а тело хунков переносим дословно.
function renderPatch(
  packageName: string,
  kept: DiffSection[],
  modeOnly: string[],
  cleanBits: Map<string, boolean>,
  modifiedBits: Map<string, boolean>,
): string {
  const gitMode = (executable: boolean): string => (executable ? '100755' : '100644');

  const renderSection = (relativePath: string, body: string[]): string => {
    const path = `node_modules/${packageName}/${relativePath}`;
    const before = cleanBits.get(relativePath);
    const after = modifiedBits.get(relativePath);
    const lines = [`diff --git a/${path} b/${path}`];

    if (before === undefined && after !== undefined) {
      lines.push(`new file mode ${gitMode(after)}`);
    } else if (before !== undefined && after === undefined) {
      lines.push(`deleted file mode ${gitMode(before)}`);
    } else if (before !== undefined && after !== undefined && before !== after) {
      lines.push(`old mode ${gitMode(before)}`, `new mode ${gitMode(after)}`);
    }

    if (body.length > 0) {
      lines.push(before === undefined ? '--- /dev/null' : `--- a/${path}`);
      lines.push(after === undefined ? '+++ /dev/null' : `+++ b/${path}`);
      lines.push(...body);
    }

    return lines.join('\n');
  };

  return [
    ...kept.map(section => renderSection(section.relativePath, section.body)),
    ...modeOnly.map(relativePath => renderSection(relativePath, [])),
  ].join('\n') + '\n';
}

// Считаем переводы строк, а не режем текст на массив: патч бывает в мегабайты,
// и миллион временных строк ради одного числа в отчёте — лишняя работа.
function countLines(text: string): number {
  let lines = 1;
  for (let at = text.indexOf('\n'); at !== -1; at = text.indexOf('\n', at + 1)) lines++;
  return lines;
}

function writePatch(plan: SequencePlan, patchContent: string, header: PatchHeaderFields): void {
  const patchLines = countLines(patchContent);
  const patchSizeKB = Buffer.byteLength(patchContent, 'utf-8') / 1024;

  if (patchSizeKB > 100) {
    console.log(`⚠️  Warning: Patch is ${patchSizeKB.toFixed(2)} KB (${patchLines} lines)`);
    console.log(`   This might include binary files. Consider adding more excludes.`);
  }

  ensureDir(patchesDirectory());

  if (plan.renameFrom !== null) {
    // Одиночный патч становится первым в последовательности.
    renameSync(join(patchesDirectory(), plan.renameFrom), join(patchesDirectory(), plan.renameTo!));
    // Запись о применённом переезжает следом — иначе она указывает на файл,
    // которого больше нет, и `status` объявляет патч пропавшим.
    renameRecordedPatch(plan.renameFrom, plan.renameTo!);
    console.log(`🔢 ${plan.renameFrom} → ${plan.renameTo}`);
  }

  const patchFilePath = join(patchesDirectory(), plan.outputName);

  // Последний рубеж: имя собрано из чужого манифеста, и уехать за пределы
  // patches/ оно не должно ни при каких значениях полей.
  //
  // Тестом эта ветка не закрыта, и закрыть её нечем: validateManifestField
  // отвергает такие поля раньше, а до сюда доходит только то, что реестр сумел
  // отдать по `<имя>@<версия>` — то есть без слэшей и точек-точек в принципе.
  // Проверено мутацией: снимаешь этот if — сюита остаётся зелёной. Это второй
  // замок на той же двери, и оставлен он намеренно.
  const patchesRoot = resolve(process.cwd(), patchesDirectory());
  if (!resolve(patchFilePath).startsWith(patchesRoot + sep)) {
    throw new Error(`Refusing to write ${plan.outputName} outside ${patchesDirectory()}/`);
  }

  // Заголовок переезжает сам. `create` перезаписывает файл патча целиком, и
  // без этого «зачем этот патч» жило бы ровно до следующей правки пакета —
  // то есть до первого раза, когда оно понадобится.
  const existing = existsSync(patchFilePath)
    ? splitPatchHeader(readFileSync(patchFilePath, 'utf-8')).header
    : '';
  const content = updatePatchHeader(existing, header) + patchContent;

  writeFileSync(patchFilePath, content);

  const hash = createHash('sha256').update(content).digest('hex');

  console.log(`✅ Patch created: ${patchFilePath}`);
  console.log(`📊 Stats:`);
  console.log(`   Lines: ${patchLines}`);
  console.log(`   Size: ${patchSizeKB.toFixed(2)} KB`);
  console.log(`   Hash: ${hash.substring(0, 12)}...`);
}

// Дифф двух деревьев одного пакета, приведённый к тексту патча. Отдельно —
// потому что этим заняты обе команды: `create` сравнивает эталон с
// node_modules, а `retarget` — два соседних состояния эталона новой версии.
export interface TreeDiff {
  content: string; // текст патча; пустой, если переносить нечего
  kept: DiffSection[];
  skipped: DiffSection[];
  filtered: DiffSection[]; // отсеянные --include/--exclude
  linkDifferences: LinkDifference[];
  modeOnly: string[];
  rawPatch: string;
}

export function diffTrees(
  cleanRoot: string,
  modifiedRoot: string,
  packageName: string,
  name: string,
  version: string,
  filters: PathFilters = {include: null, exclude: null},
): TreeDiff {
  // Деревья обходим до диффа: список расхождений по симлинкам нужен разбору
  // кода возврата самого diff.
  const cleanTree = scanTree(cleanRoot);
  const modifiedTree = scanTree(modifiedRoot);
  const linkDifferences = findLinkDifferences(cleanTree, modifiedTree);
  const missingLinkPaths = new Set(
    linkDifferences
      .filter(difference => difference.missingFrom !== null)
      .map(difference =>
        join(difference.missingFrom === 'clean' ? cleanRoot : modifiedRoot, difference.relativePath),
      ),
  );

  const rawPatch = runDiff(cleanRoot, modifiedRoot, name, version, missingLinkPaths);
  const sections = splitDiffSections(rawPatch, cleanRoot, modifiedRoot);
  const kept: DiffSection[] = [];
  const skipped: DiffSection[] = [];
  const filtered: DiffSection[] = [];

  for (const section of sections) {
    if (isBuildArtifact(section.relativePath)) skipped.push(section);
    else if (!pathAllowed(section.relativePath, filters)) filtered.push(section);
    else kept.push(section);
  }

  const modeOnly = findModeOnlyChanges(
    cleanTree.executable,
    modifiedTree.executable,
    new Set(kept.map(section => section.relativePath)),
  ).filter(relativePath => pathAllowed(relativePath, filters));

  const content =
    kept.length === 0 && modeOnly.length === 0
      ? ''
      : renderPatch(packageName, kept, modeOnly, cleanTree.executable, modifiedTree.executable);

  return {content, kept, skipped, filtered, linkDifferences, modeOnly, rawPatch};
}

export function createPatch(
  packageName: string,
  appendLabel: string | null = null,
  filters: PathFilters = {include: null, exclude: null},
  dev = false,
  header: PatchHeaderFields = {},
): void {
  validatePackageName(packageName);
  requireDiff();
  console.log(`📦 Creating patch for ${packageName}...`);

  const packagePath = join(process.cwd(), 'node_modules', packageName);
  if (!existsSync(packagePath)) {
    throw new Error(`Package ${packageName} not found in node_modules`);
  }

  // При изолированной раскладке (`bun install --linker isolated`) это симлинк на
  // node_modules/.bun/…, и GNU diff, получив симлинк вторым аргументом, ищет
  // файл с таким именем в первом каталоге: `diff: <эталон>/ms: No such file or
  // directory`. Измерено на GNU diffutils 3.12; Apple diff ссылку разыменовывает,
  // поэтому на macOS этого не видно, а на Linux и Windows `create` не работал
  // в такой раскладке вовсе. Сравниваем настоящий каталог — пути в патче
  // по-прежнему строятся из имени пакета, а не из этого пути.
  const realPackagePath = realpathSync(packagePath);

  const {name, version} = readManifest(packagePath);

  // Патч отсюда собрать можно — читать общий стор не вредно. Но сказать надо:
  // его содержимое мог изменить другой проект, и `apply` в такое дерево писать
  // откажется, так что патч рискует оказаться и неверным, и неприменимым.
  const shared = realPathOutsideProject(join('node_modules', packageName));
  if (shared !== null) {
    console.log(`⚠️  node_modules/${packageName} is a link into bun's shared store (${shared})`);
    console.log(`   Another project on this machine may have changed it, and \`apply\` will refuse to patch through it.`);
  }

  // Два механизма на один пакет дерутся, и проигрывает пользователь: патч bun
  // уже в дереве, а в эталоне его нет — значит он целиком уехал бы в наш патч,
  // и дальше применялся бы дважды. Отказываем до скачивания эталона.
  if (bunAlsoPatches(name)) {
    throw new Error(
      `${name} is already patched by bun through patchedDependencies.\n` +
        `   That patch is in node_modules but not in the pristine copy, so a patch created now\n` +
        `   would carry bun's changes too. Run \`bunch-package import\` to take it over, or remove\n` +
        `   the entry from patchedDependencies yourself.`,
    );
  }

  // Имя патча говорит, куда он ложится, поэтому для вложенной зависимости в нём
  // стоит путь, а не имя из манифеста: `foo++bar+1.0.0.patch`. Для обычного
  // пакета берём имя из манифеста — оно верно и при установке через алиас.
  const patchDir = packageName.includes('/node_modules/') ? packageName : name;

  // Патчи одного пакета образуют последовательность, где каждый следующий
  // отсчитывается от состояния после предыдущих, а не от чистого пакета.
  // Решаем, какой из них пересоздаём, **до** скачивания эталона: отказ здесь
  // возможен, и тратить на него сеть незачем — как и с проверкой diff.
  const plan = planSequence(patchDir, version, appendLabel, dev);

  withPristine(name, version, cleanPackagePath => {
    // Эталон доводится уже существующими патчами — иначе новый патч нёс бы в
    // себе и чужие правки.
    if (plan.replay.length > 0) {
      console.log(`🔁 Replaying ${plan.replay.length} existing patch(es) onto the pristine copy...`);
      replayPatches(plan.replay, packageName, cleanPackagePath);
    }

    console.log(`🔍 Generating diff...`);
    const diff = diffTrees(cleanPackagePath, realPackagePath, packageName, name, version, filters);
    reportBinaryFiles(diff.rawPatch, realPackagePath);
    reportLinkDifferences(diff.linkDifferences);
    reportSkipped(diff.skipped);
    reportFiltered(diff.filtered);

    if (diff.content === '') {
      if (diff.linkDifferences.length > 0) {
        console.log('⚠️  Nothing patchable changed — only symbolic links did');
        console.log(`\n💡 Symbolic links cannot travel in a patch. Everything else in ${packagePath} matches the pristine copy.`);
      } else if (diff.filtered.length > 0) {
        console.log('⚠️  Everything that changed was left out by --include/--exclude');
        console.log(`\n💡 The paths are listed above; they are matched against the package root.`);
      } else if (diff.skipped.length > 0) {
        console.log('⚠️  No changes outside build artifacts');
        console.log(`\n💡 Everything you changed is under a build directory — those are not patchable.`);
      } else {
        console.log('⚠️  No changes detected');
        console.log(`\n💡 Did you modify files in ${packagePath}?`);
      }
      return;
    }

    if (diff.modeOnly.length > 0) {
      console.log(`🔑 ${diff.modeOnly.length} file(s) changed only their executable bit`);
    }

    writePatch(plan, diff.content, header);
  });
}

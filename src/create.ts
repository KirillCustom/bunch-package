import {execFileSync} from 'child_process';
import {createHash} from 'crypto';
import {existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync} from 'fs';
import {join, resolve, sep} from 'path';
import {PATCHES_DIR} from './paths';
import {planSequence, replayPatches, SequencePlan} from './sequence';

// diff матчит --exclude по имени файла, а не по пути, поэтому здесь только то,
// что артефактно на любой глубине. Каталоги сборки сюда не входят: `build` у
// множества пакетов — это каталог с распространяемым кодом. Ими занимается
// isBuildArtifact() уже после диффа, по относительному пути.
export const EXCLUDE_PATTERNS = [
  'node_modules',
  '.git',
  '.DS_Store',
  // Следы неудачного apply — иначе они уезжают в следующий патч
  '*.rej',
  '*.orig',
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

// Эти имена не бывают исходниками ни на какой глубине.
export const ARTIFACT_SEGMENTS = ['.gradle', '.cxx', '.transforms', 'DerivedData', 'Pods'];

// А `build` бывает: под платформенным каталогом это артефакт, в корне пакета —
// обычно его собранный JavaScript. Поэтому только с якорем.
export const ARTIFACT_PREFIXES = ['android/build', 'ios/build', 'macos/build', 'windows/build'];

export function isBuildArtifact(relativePath: string): boolean {
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
export function collectExecutableBits(root: string, prefix = ''): Map<string, boolean> {
  const found = new Map<string, boolean>();
  if (!existsSync(root)) return found;

  for (const entry of readdirSync(root, {withFileTypes: true})) {
    const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isSymbolicLink()) continue;

    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      if (isBuildArtifact(relative)) continue;
      for (const [key, value] of collectExecutableBits(join(root, entry.name), relative)) {
        found.set(key, value);
      }
      continue;
    }

    if (!entry.isFile()) continue;
    found.set(relative, (statSync(join(root, entry.name)).mode & 0o111) !== 0);
  }

  return found;
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
export function splitDiffSections(diffOutput: string, cleanRoot: string, modifiedRoot: string): DiffSection[] {
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
  if (!/^(@[\w.-]+\/)?[\w.-]+$/.test(name)) {
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
export function validateManifestField(field: string, value: unknown): string {
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
  const streams = `${error.stderr?.toString() ?? ''}\n${error.stdout?.toString() ?? ''}`
    .split('\n')
    .map((line: string) => line.trim())
    .filter(Boolean);
  return streams[0] ?? (error.message ? String(error.message).split('\n')[0].trim() : '');
}

interface Manifest {
  name: string;
  version: string;
}

function readManifest(packagePath: string): Manifest {
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
// Лечится изоляцией кеша: BUN_INSTALL_CACHE_DIR внутри temp заставляет bun
// скачать пакет заново, и разделить иноды с node_modules проекта он уже не может.
function fetchPristine(name: string, version: string, tempDir: string): string {
  writeFileSync(
    join(tempDir, 'package.json'),
    JSON.stringify({name: 'temp', version: '1.0.0'}, null, 2),
  );

  const failures: string[] = [];

  try {
    execFileSync('bun', ['add', '--no-save', `${name}@${version}`], {
      cwd: tempDir,
      stdio: 'pipe',
      timeout: 60000,
      env: {...process.env, BUN_INSTALL_CACHE_DIR: join(tempDir, 'cache')},
    });
    // Имя каталога в node_modules не обязано совпадать с именем пакета: при
    // установке через алиас (`"mynum": "npm:is-number@7.0.0"`) они разные.
    // Путь к эталону строим по имени из манифеста, а не по аргументу команды.
    return join(tempDir, 'node_modules', name);
  } catch (error: any) {
    failures.push(`bun: ${firstDiagnosticLine(error) || error.message}`);
  }

  // Запасной путь — тарбол из реестра. Он тоже мимо кеша bun, но требует npm,
  // которого нет, например, в официальном образе oven/bun.
  try {
    const packed = execFileSync('npm', ['pack', '--silent', '--pack-destination', tempDir, `${name}@${version}`], {
      cwd: tempDir,
      encoding: 'utf-8',
      timeout: 60000,
    });
    const printed = packed.split('\n').map(line => line.trim()).filter(Boolean).pop();
    if (!printed) throw new Error('npm pack printed no tarball name');
    execFileSync('tar', ['-xzf', join(tempDir, printed), '-C', tempDir], {stdio: 'pipe', timeout: 60000});
    return join(tempDir, 'package'); // тарболы npm всегда распаковываются сюда
  } catch (npmError: any) {
    failures.push(`npm: ${firstDiagnosticLine(npmError) || npmError.message}`);
    throw new Error(`Could not fetch a pristine ${name}@${version}:\n   ${failures.join('\n   ')}`);
  }
}

function runDiff(cleanPackagePath: string, packagePath: string, name: string, version: string): string {
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
    rawBuffer = execFileSync('diff', diffArgs, {maxBuffer: 50 * 1024 * 1024});
  } catch (error: any) {
    // diff: 0 — совпало, 1 — есть различия, 2 и выше — сбой.
    if (error.status !== 1) {
      const reason = (error.stderr?.toString() || error.message || '').split('\n').filter(Boolean)[0];
      throw new Error(`diff failed: ${reason}`);
    }
    rawBuffer = error.stdout ?? Buffer.alloc(0);
  }

  // Читать вывод сразу как utf-8 нельзя: каждый неверный байт превращался в
  // U+FFFD, патч уезжал испорченным, а apply молча записывал не те байты.
  // Лучше отказаться вслух, чем тихо испортить файл.
  const rawPatch = rawBuffer.toString('utf-8');
  if (!Buffer.from(rawPatch, 'utf-8').equals(rawBuffer)) {
    throw new Error(
      `The diff for ${name}@${version} is not valid UTF-8 — some changed file is binary ` +
        `or in another encoding. Writing this patch would corrupt it.`,
    );
  }

  return rawPatch;
}

// Двоичные файлы diff в патч не включает, печатая одну строку. Без этого
// сообщения их изменение просто пропадало.
function reportBinaryFiles(rawPatch: string, packagePath: string): void {
  const notices = rawPatch
    .split('\n')
    .filter(line => line.startsWith('Binary files ') && line.endsWith(' differ'));

  if (notices.length === 0) return;

  console.log(`⚠️  ${notices.length} binary file(s) differ and cannot be patched:`);
  for (const notice of notices.slice(0, 5)) {
    const paths = notice.slice('Binary files '.length, -' differ'.length);
    const modified = paths.split(' and ').pop() ?? paths;
    console.log(`   ${modified.startsWith(packagePath + sep) ? modified.slice(packagePath.length + 1) : modified}`);
  }
  if (notices.length > 5) {
    console.log(`   ...and ${notices.length - 5} more`);
  }
}

function reportSkipped(skipped: DiffSection[]): void {
  if (skipped.length === 0) return;

  console.log(`⏭  Skipped ${skipped.length} build-artifact path(s):`);
  for (const section of skipped.slice(0, 5)) {
    console.log(`   ${section.relativePath}`);
  }
  if (skipped.length > 5) {
    console.log(`   ...and ${skipped.length - 5} more`);
  }
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

function writePatch(plan: SequencePlan, patchContent: string): void {
  const patchLines = patchContent.split('\n').length;
  const patchSizeKB = Buffer.byteLength(patchContent, 'utf-8') / 1024;

  if (patchSizeKB > 100) {
    console.log(`⚠️  Warning: Patch is ${patchSizeKB.toFixed(2)} KB (${patchLines} lines)`);
    console.log(`   This might include binary files. Consider adding more excludes.`);
  }

  if (!existsSync(PATCHES_DIR)) {
    mkdirSync(PATCHES_DIR, {recursive: true});
  }

  if (plan.renameFrom !== null) {
    // Одиночный патч становится первым в последовательности.
    renameSync(join(PATCHES_DIR, plan.renameFrom), join(PATCHES_DIR, plan.renameTo!));
    console.log(`🔢 ${plan.renameFrom} → ${plan.renameTo}`);
  }

  const patchFilePath = join(PATCHES_DIR, plan.outputName);

  // Последний рубеж: имя собрано из чужого манифеста, и уехать за пределы
  // patches/ оно не должно ни при каких значениях полей.
  const patchesRoot = resolve(process.cwd(), PATCHES_DIR);
  if (!resolve(patchFilePath).startsWith(patchesRoot + sep)) {
    throw new Error(`Refusing to write ${plan.outputName} outside ${PATCHES_DIR}/`);
  }

  writeFileSync(patchFilePath, patchContent);

  const hash = createHash('sha256').update(patchContent).digest('hex');

  console.log(`✅ Patch created: ${patchFilePath}`);
  console.log(`📊 Stats:`);
  console.log(`   Lines: ${patchLines}`);
  console.log(`   Size: ${patchSizeKB.toFixed(2)} KB`);
  console.log(`   Hash: ${hash.substring(0, 12)}...`);
}

export function createPatch(packageName: string, appendLabel: string | null = null): void {
  validatePackageName(packageName);
  requireDiff();
  console.log(`📦 Creating patch for ${packageName}...`);

  const packagePath = join(process.cwd(), 'node_modules', packageName);
  if (!existsSync(packagePath)) {
    throw new Error(`Package ${packageName} not found in node_modules`);
  }

  const {name, version} = readManifest(packagePath);
  const tempDir = join(process.cwd(), '.bunch-patch-tmp');

  try {
    rmSync(tempDir, {force: true, recursive: true});
    mkdirSync(tempDir, {recursive: true});

    console.log(`📥 Fetching pristine ${name}@${version}...`);
    const cleanPackagePath = fetchPristine(name, version, tempDir);

    // Без этой проверки отсутствующий эталон не заметен: diff -N трактует
    // недостающую сторону как пустую и выдаёт патч «добавить все файлы».
    if (!existsSync(cleanPackagePath)) {
      throw new Error(`Pristine copy of ${name}@${version} did not land at ${cleanPackagePath}`);
    }

    // Патчи одного пакета образуют последовательность, где каждый следующий
    // отсчитывается от состояния после предыдущих, а не от чистого пакета.
    // Поэтому эталон сначала доводится уже существующими патчами — иначе новый
    // патч нёс бы в себе и чужие правки.
    const plan = planSequence(name.replace(/\//g, '+'), version, appendLabel);

    if (plan.replay.length > 0) {
      console.log(`🔁 Replaying ${plan.replay.length} existing patch(es) onto the pristine copy...`);
      replayPatches(plan.replay, packageName, cleanPackagePath);
    }

    console.log(`🔍 Generating diff...`);
    const rawPatch = runDiff(cleanPackagePath, packagePath, name, version);
    reportBinaryFiles(rawPatch, packagePath);

    const sections = splitDiffSections(rawPatch, cleanPackagePath, packagePath);
    const kept = sections.filter(section => !isBuildArtifact(section.relativePath));
    reportSkipped(sections.filter(section => isBuildArtifact(section.relativePath)));

    const cleanBits = collectExecutableBits(cleanPackagePath);
    const modifiedBits = collectExecutableBits(packagePath);
    const modeOnly = findModeOnlyChanges(
      cleanBits,
      modifiedBits,
      new Set(kept.map(section => section.relativePath)),
    );

    if (kept.length === 0 && modeOnly.length === 0) {
      if (sections.length > 0) {
        console.log('⚠️  No changes outside build artifacts');
        console.log(`\n💡 Everything you changed is under a build directory — those are not patchable.`);
      } else {
        console.log('⚠️  No changes detected');
        console.log(`\n💡 Did you modify files in ${packagePath}?`);
      }
      return;
    }

    if (modeOnly.length > 0) {
      console.log(`🔑 ${modeOnly.length} file(s) changed only their executable bit`);
    }

    writePatch(plan, renderPatch(packageName, kept, modeOnly, cleanBits, modifiedBits));
  } finally {
    rmSync(tempDir, {force: true, recursive: true});
  }
}

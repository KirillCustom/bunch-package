#!/usr/bin/env bun

import {execFileSync} from 'child_process';
import {createHash} from 'crypto';
import {chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, rmSync} from 'fs';
import {join, resolve, sep} from 'path';

const PATCHES_DIR = 'patches';

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
function collectExecutableBits(root: string, prefix = ''): Map<string, boolean> {
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

interface DiffSection {
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

function validatePackageName(name: string): void {
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
function validateManifestField(field: string, value: unknown): string {
  if (typeof value !== 'string' || !/^[\w.@/+-]+$/.test(value) || value.split(/[/\\]/).some(s => s === '.' || s === '..')) {
    throw new Error(`Package manifest has an unusable ${field}: ${String(value)}`);
  }
  return value;
}

function createPatch(packageName: string): void {
  validatePackageName(packageName);
  console.log(`📦 Creating patch for ${packageName}...`);

  const nodeModulesPath = join(process.cwd(), 'node_modules');
  const packagePath = join(nodeModulesPath, packageName);

  if (!existsSync(packagePath)) {
    throw new Error(`Package ${packageName} not found in node_modules`);
  }

  const packageJsonPath = join(packagePath, 'package.json');
  const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
  const name = validateManifestField('name', packageJson.name);
  const version = validateManifestField('version', packageJson.version);

  const tempDir = join(process.cwd(), '.bunch-patch-tmp');

  try {
    if (existsSync(tempDir)) {
      rmSync(tempDir, {force: true, recursive: true});
    }

    mkdirSync(tempDir, {recursive: true});

    // Эталон нельзя ставить обычным `bun add`: bun раскладывает пакеты
    // hardlink'ами, поэтому файл в node_modules и запись в глобальном кеше —
    // один инод. Правка файла меняет кеш, «чистая» установка приезжает уже
    // изменённой, и diff сравнивает файл сам с собой, отдавая «No changes
    // detected». На Linux это поведение по умолчанию.
    //
    // Лечится изоляцией кеша: BUN_INSTALL_CACHE_DIR внутри temp заставляет bun
    // скачать пакет заново, и разделить иноды с node_modules проекта он уже не может.
    console.log(`📥 Fetching pristine ${name}@${version}...`);

    writeFileSync(
      join(tempDir, 'package.json'),
      JSON.stringify({name: 'temp', version: '1.0.0'}, null, 2),
    );

    // Имя каталога в node_modules не обязано совпадать с именем пакета: при
    // установке через алиас (`"mynum": "npm:is-number@7.0.0"`) они разные.
    // Путь к эталону строим по имени из манифеста, а не по аргументу команды.
    let cleanPackagePath = join(tempDir, 'node_modules', name);
    const failures: string[] = [];

    try {
      execFileSync('bun', ['add', '--no-save', `${name}@${version}`], {
        cwd: tempDir,
        stdio: 'pipe',
        timeout: 60000,
        env: {...process.env, BUN_INSTALL_CACHE_DIR: join(tempDir, 'cache')},
      });
    } catch (error: any) {
      failures.push(`bun: ${firstDiagnosticLine(error) || error.message}`);

      // Запасной путь — тарбол из реестра. Он тоже мимо кеша bun, но требует
      // npm, которого нет, например, в официальном образе oven/bun.
      try {
        const packed = execFileSync('npm', ['pack', '--silent', '--pack-destination', tempDir, `${name}@${version}`], {
          cwd: tempDir,
          encoding: 'utf-8',
          timeout: 60000,
        });
        const printed = packed.split('\n').map(line => line.trim()).filter(Boolean).pop();
        if (!printed) throw new Error('npm pack printed no tarball name');
        execFileSync('tar', ['-xzf', join(tempDir, printed), '-C', tempDir], {stdio: 'pipe', timeout: 60000});
        cleanPackagePath = join(tempDir, 'package'); // тарболы npm всегда распаковываются сюда
      } catch (npmError: any) {
        failures.push(`npm: ${firstDiagnosticLine(npmError) || npmError.message}`);
        throw new Error(`Could not fetch a pristine ${name}@${version}:\n   ${failures.join('\n   ')}`);
      }
    }

    // Без этой проверки отсутствующий эталон не заметен: diff -N трактует
    // недостающую сторону как пустую и выдаёт патч «добавить все файлы».
    if (!existsSync(cleanPackagePath)) {
      throw new Error(`Pristine copy of ${name}@${version} did not land at ${cleanPackagePath}`);
    }

    console.log(`🔍 Generating diff...`);

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

    // Двоичные файлы diff в патч не включает, печатая одну строку. Без этого
    // сообщения их изменение просто пропадало.
    const binaryNotices = rawPatch
      .split('\n')
      .filter(line => line.startsWith('Binary files ') && line.endsWith(' differ'));

    if (binaryNotices.length > 0) {
      console.log(`⚠️  ${binaryNotices.length} binary file(s) differ and cannot be patched:`);
      for (const notice of binaryNotices.slice(0, 5)) {
        const paths = notice.slice('Binary files '.length, -' differ'.length);
        const modified = paths.split(' and ').pop() ?? paths;
        console.log(`   ${modified.startsWith(packagePath + sep) ? modified.slice(packagePath.length + 1) : modified}`);
      }
      if (binaryNotices.length > 5) {
        console.log(`   ...and ${binaryNotices.length - 5} more`);
      }
    }

    const sections = splitDiffSections(rawPatch, cleanPackagePath, packagePath);
    const kept = sections.filter(section => !isBuildArtifact(section.relativePath));
    const skipped = sections.filter(section => isBuildArtifact(section.relativePath));

    if (skipped.length > 0) {
      console.log(`⏭  Skipped ${skipped.length} build-artifact path(s):`);
      for (const section of skipped.slice(0, 5)) {
        console.log(`   ${section.relativePath}`);
      }
      if (skipped.length > 5) {
        console.log(`   ...and ${skipped.length - 5} more`);
      }
    }

    // Файлы, у которых изменился только бит исполнения: в диффе их нет.
    const cleanBits = collectExecutableBits(cleanPackagePath);
    const modifiedBits = collectExecutableBits(packagePath);
    const changedSections = new Set(kept.map(section => section.relativePath));

    const modeOnly = [...modifiedBits.entries()]
      .filter(([relativePath, executable]) => {
        if (changedSections.has(relativePath)) return false;
        const before = cleanBits.get(relativePath);
        return before !== undefined && before !== executable;
      })
      .map(([relativePath]) => relativePath)
      .sort();

    if (kept.length === 0 && modeOnly.length === 0) {
      if (skipped.length > 0) {
        console.log('⚠️  No changes outside build artifacts');
        console.log(`\n💡 Everything you changed is under a build directory — those are not patchable.`);
      } else {
        console.log('⚠️  No changes detected');
        console.log(`\n💡 Did you modify files in ${packagePath}?`);
      }
      return;
    }

    // Заголовки собираем заново из путей, а тело хунков переносим дословно.
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

    const patchContent = [
      ...kept.map(section => renderSection(section.relativePath, section.body)),
      ...modeOnly.map(relativePath => renderSection(relativePath, [])),
    ].join('\n') + '\n';

    if (modeOnly.length > 0) {
      console.log(`🔑 ${modeOnly.length} file(s) changed only their executable bit`);
    }

    // Проверяем размер патча
    const patchLines = patchContent.split('\n').length;
    const patchSizeKB = Buffer.byteLength(patchContent, 'utf-8') / 1024;

    if (patchSizeKB > 100) {
      console.log(
        `⚠️  Warning: Patch is ${patchSizeKB.toFixed(
          2,
        )} KB (${patchLines} lines)`,
      );
      console.log(
        `   This might include binary files. Consider adding more excludes.`,
      );
    }

    if (!existsSync(PATCHES_DIR)) {
      mkdirSync(PATCHES_DIR, {recursive: true});
    }

    const sanitizedName = name.replace(/\//g, '+');
    const patchFileName = `${sanitizedName}+${version}.patch`;
    const patchFilePath = join(PATCHES_DIR, patchFileName);

    // Последний рубеж: имя собрано из чужого манифеста, и уехать за пределы
    // patches/ оно не должно ни при каких значениях полей.
    const patchesRoot = resolve(process.cwd(), PATCHES_DIR);
    if (!resolve(patchFilePath).startsWith(patchesRoot + sep)) {
      throw new Error(`Refusing to write ${patchFileName} outside ${PATCHES_DIR}/`);
    }

    writeFileSync(patchFilePath, patchContent);

    const hash = createHash('sha256').update(patchContent).digest('hex');

    console.log(`✅ Patch created: ${patchFilePath}`);
    console.log(`📊 Stats:`);
    console.log(`   Lines: ${patchLines}`);
    console.log(`   Size: ${patchSizeKB.toFixed(2)} KB`);
    console.log(`   Hash: ${hash.substring(0, 12)}...`);
  } finally {
    if (existsSync(tempDir)) {
      rmSync(tempDir, {force: true, recursive: true});
    }
  }
}

// Ниже — собственное применение унифицированных диффов. Раньше эту работу делал
// системный patch(1), и половина проблем росла именно оттуда: на Linux это GNU,
// на macOS — Apple, у них расходятся коды возврата, тексты сообщений и даже
// защита от выхода за корень проекта. Плюс patch применяет файлы по одному,
// поэтому провал на середине оставлял дерево наполовину пропатченным и сыпал
// .rej/.orig. Здесь ничего не пишется на диск, пока не сойдётся весь патч.

interface Hunk {
  oldStart: number;
  newStart: number;
  lines: string[]; // с префиксами ' ', '+', '-'
  oldNoNewline: boolean;
  newNoNewline: boolean;
}

interface PatchTarget {
  oldPath: string | null; // null — это /dev/null, то есть файл создаётся
  newPath: string | null; // null — файл удаляется
  hunks: Hunk[];
  oldMode: string | null; // '100644' / '100755' из git-заголовков
  newMode: string | null;
}

function parsePatch(patchContent: string): PatchTarget[] {
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

  const openTarget = (): PatchTarget => {
    if (!open || target === null) {
      target = {oldPath: null, newPath: null, hunks: [], oldMode: null, newMode: null};
      targets.push(target);
      open = true;
      hunk = null;
    }
    return target;
  };

  for (const line of patchContent.split('\n')) {
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
      hunk.lines.push(line);
      lastPrefix = line.charAt(0);
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
      open = false;
      const fresh = openTarget();
      fresh.oldPath = gitHeader[1];
      fresh.newPath = gitHeader[2];
      continue;
    }

    // Режимы приходят git-заголовками. patch-package читает ровно эти строки,
    // поэтому формат патча остаётся с ним совместимым.
    const modeLine = line.match(/^(old|new|new file|deleted file) mode (\d+)$/);
    if (modeLine) {
      const current = openTarget();
      if (modeLine[1] === 'old' || modeLine[1] === 'deleted file') current.oldMode = modeLine[2];
      else current.newMode = modeLine[2];
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
      const current = openTarget();
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
  return targets.filter(t => t.hunks.length > 0 || t.newMode !== null || t.oldMode !== null);
}

// Одна сторона хунка: для старой отбрасываем добавленные строки, для новой — удалённые.
// Пустая строка — это контекст, у которого срезали хвостовой пробел.
function sideLines(hunk: Hunk, side: 'old' | 'new'): string[] {
  const drop = side === 'old' ? '+' : '-';
  return hunk.lines.filter(line => !line.startsWith(drop)).map(line => line.slice(1));
}

// Хунк ищем сначала там, где он объявлен, потом расходящимся поиском — ровно как
// это делает patch со смещением. Нечёткого совпадения (fuzz) не допускаем: патч
// делался под конкретную версию, и подгонять контекст молча — это как раз то,
// из-за чего провалы выглядели успехами.
function locateHunk(lines: string[], needle: string[], preferred: number): number {
  const fits = (at: number): boolean =>
    at >= 0 &&
    at + needle.length <= lines.length &&
    needle.every((line, index) => lines[at + index] === line);

  if (needle.length === 0) return Math.max(0, Math.min(preferred, lines.length));
  if (fits(preferred)) return preferred;

  for (let distance = 1; distance <= lines.length; distance++) {
    if (fits(preferred - distance)) return preferred - distance;
    if (fits(preferred + distance)) return preferred + distance;
  }
  return -1;
}

interface AppliedFile {
  lines: string[];
  endsWithNewline: boolean;
}

function applyHunks(
  original: string[],
  endsWithNewline: boolean,
  hunks: Hunk[],
  reverse: boolean,
): AppliedFile | {error: string} {
  let lines = original;
  let offset = 0;
  let trailing = endsWithNewline;

  for (const [index, hunk] of hunks.entries()) {
    const from = sideLines(hunk, reverse ? 'new' : 'old');
    const to = sideLines(hunk, reverse ? 'old' : 'new');
    const declared = (reverse ? hunk.newStart : hunk.oldStart) - 1;

    const at = locateHunk(lines, from, Math.max(0, declared + offset));
    if (at === -1) {
      return {error: `hunk #${index + 1} does not fit (expected at line ${declared + 1})`};
    }

    const reachedEnd = at + from.length === lines.length;
    lines = [...lines.slice(0, at), ...to, ...lines.slice(at + from.length)];
    offset += to.length - from.length;

    if (reachedEnd) {
      trailing = !(reverse ? hunk.oldNoNewline : hunk.newNoNewline);
    }
  }

  return {lines, endsWithNewline: trailing};
}

// -p1: срезаем первый компонент пути, как это делает patch.
function stripPathPrefix(path: string): string {
  const slash = path.indexOf('/');
  return slash === -1 ? path : path.slice(slash + 1);
}

type PlannedOp =
  | {kind: 'write'; file: string; content: string; mode: number | null}
  | {kind: 'remove'; file: string}
  | {kind: 'chmod'; file: string; mode: number};

// Единственная защита от выхода за корень проекта. Полагаться здесь на patch(1)
// было нельзя: GNU такие пути отвергает, Apple спокойно пишет файл наружу.
function resolveInsideProject(relativePath: string): string {
  const root = process.cwd();
  const resolved = resolve(root, relativePath);
  if (resolved !== root && !resolved.startsWith(root + sep)) {
    throw new Error(`refusing to touch ${relativePath} — it resolves outside the project`);
  }
  return resolved;
}

function packageDirectoryOf(relativePath: string): string | null {
  const parts = relativePath.split('/');
  if (parts[0] !== 'node_modules' || parts.length < 2) return null;
  const depth = parts[1].startsWith('@') ? 3 : 2;
  return parts.slice(0, depth).join('/');
}

// Как и git, из всех прав отслеживаем только бит исполнения: сравнивать полные
// режимы нельзя — у распакованного эталона и у node_modules разный umask.
const EXECUTABLE = 0o111;

// На Windows бита исполнения не существует: NTFS его не хранит, chmod почти
// no-op, а statSync возвращает одинаковый режим всем файлам. Без этой проверки
// apply каждый раз видел бы «нужно выставить бит», звал chmod вхолостую и
// бесконечно рапортовал о проделанной работе. Патч со сменой режима, приехавший
// с macOS или Linux, должен применяться там молча и ровно один раз.
const MODES_SUPPORTED = process.platform !== 'win32';

function isExecutable(mode: number): boolean {
  return (mode & EXECUTABLE) !== 0;
}

function withExecutable(mode: number, executable: boolean): number {
  return executable ? mode | 0o111 : mode & ~0o111;
}

function planTarget(target: PatchTarget): PlannedOp[] {
  const rawPath = target.newPath ?? target.oldPath;
  if (rawPath === null) throw new Error('patch section has no file path');

  const relativePath = stripPathPrefix(rawPath);
  const file = resolveInsideProject(relativePath);

  const packageDir = packageDirectoryOf(relativePath);
  if (packageDir !== null && !existsSync(packageDir)) {
    throw new Error(`${packageDir} is not installed`);
  }

  const exists = existsSync(file);
  const currentMode = exists ? statSync(file).mode : null;
  const wantExecutable =
    target.newMode === null || !MODES_SUPPORTED ? null : target.newMode === '100755';

  // Файл удаляется — это сказано заголовком, а не выведено из пустого результата.
  if (target.newPath === null) {
    return exists ? [{kind: 'remove', file}] : [];
  }

  const ops: PlannedOp[] = [];

  if (target.hunks.length > 0) {
    const raw = exists ? readFileSync(file, 'utf-8') : '';
    const lines = raw === '' ? [] : raw.split('\n');
    const endsWithNewline = lines.length > 0 && lines[lines.length - 1] === '';
    if (endsWithNewline) lines.pop();

    // Патч создаёт файл, а файл уже есть и не пуст — применять такое вслепую
    // значит подмешать содержимое к чужому файлу.
    const isCreation = target.oldPath === null || target.hunks.every(h => sideLines(h, 'old').length === 0);
    let alreadyApplied = false;

    if (isCreation && exists && raw !== '') {
      const reverse = applyHunks(lines, endsWithNewline, target.hunks, true);
      if ('error' in reverse) throw new Error(`${relativePath} already exists`);
      alreadyApplied = true;
    } else {
      // «Уже применён» проверяем обратным применением, а не прямым: патч, который
      // только дописывает строки, ложится вперёд и во второй раз — так дублировалось
      // содержимое файлов.
      //
      // Но у патча на удаление новая сторона пуста, а пустой образец совпадает с чем
      // угодно, поэтому для него обратная проверка ничего не значит: там признак
      // применённости — отсутствующий или пустой файл.
      const hasNewContent = target.hunks.some(h => sideLines(h, 'new').length > 0);

      if (!hasNewContent) {
        alreadyApplied = !exists || raw === '';
      } else {
        const reverse = applyHunks(lines, endsWithNewline, target.hunks, true);
        alreadyApplied = !('error' in reverse);
      }
    }

    if (!alreadyApplied) {
      const forward = applyHunks(lines, endsWithNewline, target.hunks, false);
      if ('error' in forward) throw new Error(`${relativePath}: ${forward.error}`);

      const content = forward.lines.join('\n') + (forward.endsWithNewline ? '\n' : '');

      // patch(1) удаляет файл, от которого ничего не осталось. Повторяем это, иначе
      // патч на удаление оставлял пустышку и ломал каждый следующий прогон.
      if (content === '' || content === '\n') {
        return [{kind: 'remove', file}];
      }

      // Запись идёт через пересоздание файла, чтобы разорвать hardlink на общий
      // кеш bun, — а значит режим надо проставить заново, иначе бит исполнения
      // терялся бы у любого патченого файла.
      const base = currentMode ?? 0o644;
      const mode = wantExecutable === null ? base : withExecutable(base, wantExecutable);
      ops.push({kind: 'write', file, content, mode});
    }
  }

  // Смена режима без изменения содержимого — отдельная секция патча.
  if (wantExecutable !== null && !ops.some(op => op.kind === 'write')) {
    if (currentMode === null) throw new Error(`${relativePath}: cannot change mode, file is missing`);
    if (isExecutable(currentMode) !== wantExecutable) {
      ops.push({kind: 'chmod', file, mode: withExecutable(currentMode, wantExecutable)});
    }
  }

  return ops;
}

function applyPatches(): void {
  console.log(`🔧 Applying patches...`);

  if (!existsSync(PATCHES_DIR)) {
    console.log('📭 No patches directory found');
    return;
  }

  const patchFiles = readdirSync(PATCHES_DIR)
    .filter((f: string) => f.endsWith('.patch'));

  if (patchFiles.length === 0) {
    console.log('📭 No patches found');
    return;
  }

  let applied = 0;
  let failed = 0;

  for (const patchFile of patchFiles) {
    const patchPath = join(PATCHES_DIR, patchFile);

    const fail = (reason: string) => {
      failed++;
      console.log(`  ❌ ${patchFile}`);
      console.log(`     ${reason}`);
    };

    console.log(`  Applying ${patchFile}...`);

    let patchContent: string;
    try {
      patchContent = readFileSync(patchPath, 'utf-8');
    } catch (error: any) {
      fail(`cannot read patch file: ${error.message}`);
      continue;
    }

    const targets = parsePatch(patchContent);

    if (targets.length === 0) {
      fail('no hunks found — the patch file is empty or truncated');
      continue;
    }

    // Версию сверяем по пакету из заголовков, а не по имени файла патча: при
    // установке через алиас каталог называется иначе, чем пакет, и разбор имени
    // файла уводил проверку к несуществующему манифесту — она молча пропадала.
    const patchVersion = patchFile.match(/^.+\+(\d+\..+)\.patch$/)?.[1];
    if (patchVersion !== undefined) {
      const packageDirs = new Set(
        targets
          .map(t => packageDirectoryOf(stripPathPrefix(t.newPath ?? t.oldPath ?? '')))
          .filter((dir): dir is string => dir !== null),
      );
      for (const dir of packageDirs) {
        const pkgJsonPath = join(dir, 'package.json');
        if (!existsSync(pkgJsonPath)) continue;
        // Битый манифест не должен ронять весь прогон — проверку просто пропускаем.
        let installedVersion: string | undefined;
        try {
          installedVersion = JSON.parse(readFileSync(pkgJsonPath, 'utf-8')).version;
        } catch {
          console.log(`  ⚠️  ${patchFile} — cannot read ${pkgJsonPath}, skipping version check`);
        }
        if (installedVersion !== undefined && installedVersion !== patchVersion) {
          console.log(`  ⚠️  ${patchFile} — version mismatch (patch: ${patchVersion}, installed: ${installedVersion})`);
        }
      }
    }

    // Патчи до 1.1.0 писали в заголовки абсолютные пути. Под -p1 первый компонент
    // срезается, и `/Users/...` превращается в `Users/...` — путь, которого в
    // проекте нет. Ловим это отдельно, чтобы сказать пользователю правду.
    const absolute = targets
      .flatMap(t => [t.oldPath, t.newPath])
      .find(path => path !== null && path.startsWith('/'));
    if (absolute !== undefined) {
      fail(`absolute path in patch header (${absolute}) — created by bunch-package < 1.1.0, recreate it with \`create\``);
      continue;
    }

    // Считаем весь патч в памяти: пока не сойдётся целиком, на диск не идёт
    // ничего. Это и есть ответ на «применилось наполовину, а в отчёте ноль».
    const writes: PlannedOp[] = [];
    let failure: string | null = null;

    for (const target of targets) {
      try {
        writes.push(...planTarget(target));
      } catch (error: any) {
        failure = error.message;
        break;
      }
    }

    if (failure !== null) {
      fail(failure);
      continue;
    }

    if (writes.length === 0) {
      applied++;
      console.log(`  ✅ ${patchFile} (already applied)`);
      continue;
    }

    try {
      for (const write of writes) {
        if (write.kind === 'remove') {
          rmSync(write.file, {force: true});
          continue;
        }
        if (write.kind === 'chmod') {
          chmodSync(write.file, write.mode);
          continue;
        }
        mkdirSync(join(write.file, '..'), {recursive: true});
        // Разрываем hardlink на общий кеш bun: запись на месте изменила бы и его.
        rmSync(write.file, {force: true});
        writeFileSync(write.file, write.content);
        if (write.mode !== null) chmodSync(write.file, write.mode);
      }
    } catch (error: any) {
      fail(`could not write: ${error.message}`);
      continue;
    }

    applied++;
    console.log(`  ✅ ${patchFile}`);
  }

  console.log(`\n📊 Summary: ${applied} applied, ${failed} failed`);

  if (failed > 0) {
    process.exit(1);
  }
}

// Main
const command = process.argv[2];
const arg = process.argv[3];

switch (command) {
  case 'create':
    if (!arg) {
      console.error('❌ Usage: bunch-package create <package-name>');
      process.exit(1);
    }

    createPatch(arg);
    break;

  case 'apply':
    applyPatches();
    break;

  default:
    console.log(`
🎯 bunch-package - Patch management for Bun

Commands:
  bunch-package create <package>  Create a patch
  bunch-package apply             Apply all patches
    `);
}

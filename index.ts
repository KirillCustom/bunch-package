#!/usr/bin/env bun

import {execFileSync} from 'child_process';
import {createHash} from 'crypto';
import {existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, rmSync} from 'fs';
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

    if (kept.length === 0) {
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
    const patchContent = kept
      .map(section => {
        const path = `node_modules/${packageName}/${section.relativePath}`;
        return [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, ...section.body].join('\n');
      })
      .join('\n') + '\n';

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
}

function parsePatch(patchContent: string): PatchTarget[] {
  const targets: PatchTarget[] = [];
  let target: PatchTarget | null = null;
  let hunk: Hunk | null = null;
  let oldLeft = 0;
  let newLeft = 0;
  let lastPrefix = '';

  const asPath = (raw: string): string | null => (raw === '/dev/null' ? null : raw);

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

    const head = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (head && target) {
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
      continue;
    }

    const oldHeader = line.match(/^--- ([^\t]+)/);
    if (oldHeader) {
      target = {oldPath: asPath(oldHeader[1]), newPath: null, hunks: []};
      targets.push(target);
      hunk = null;
      continue;
    }

    const newHeader = line.match(/^\+\+\+ ([^\t]+)/);
    if (newHeader && target) {
      target.newPath = asPath(newHeader[1]);
      continue;
    }
  }

  return targets.filter(t => t.hunks.length > 0);
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

interface PlannedWrite {
  file: string;
  content: string | null; // null — файл нужно удалить
}

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

interface TargetResult {
  write: PlannedWrite | null; // null — файл уже в нужном состоянии
}

function planTarget(target: PatchTarget): TargetResult {
  const rawPath = target.newPath ?? target.oldPath;
  if (rawPath === null) throw new Error('patch section has no file path');

  const relativePath = stripPathPrefix(rawPath);
  const file = resolveInsideProject(relativePath);

  const packageDir = packageDirectoryOf(relativePath);
  if (packageDir !== null && !existsSync(packageDir)) {
    throw new Error(`${packageDir} is not installed`);
  }

  const exists = existsSync(file);
  const raw = exists ? readFileSync(file, 'utf-8') : '';
  const lines = raw === '' ? [] : raw.split('\n');
  const endsWithNewline = lines.length > 0 && lines[lines.length - 1] === '';
  if (endsWithNewline) lines.pop();

  // Патч создаёт файл, а файл уже есть и не пуст — применять такое вслепую
  // значит подмешать содержимое к чужому файлу.
  const isCreation = target.oldPath === null || target.hunks.every(h => sideLines(h, 'old').length === 0);
  if (isCreation && exists && raw !== '') {
    const reverse = applyHunks(lines, endsWithNewline, target.hunks, true);
    if ('error' in reverse) throw new Error(`${relativePath} already exists`);
    return {write: null};
  }

  // «Уже применён» проверяем обратным применением, а не прямым: патч, который
  // только дописывает строки, ложится вперёд и во второй раз — так дублировалось
  // содержимое файлов.
  //
  // Но у патча на удаление новая сторона пуста, а пустой образец совпадает с чем
  // угодно, поэтому для него обратная проверка ничего не значит: там признак
  // применённости — отсутствующий или пустой файл.
  const hasNewContent = target.hunks.some(h => sideLines(h, 'new').length > 0);

  if (!hasNewContent) {
    if (!exists || raw === '') return {write: null};
  } else {
    const reverse = applyHunks(lines, endsWithNewline, target.hunks, true);
    if (!('error' in reverse)) return {write: null};
  }

  const forward = applyHunks(lines, endsWithNewline, target.hunks, false);
  if ('error' in forward) throw new Error(`${relativePath}: ${forward.error}`);

  const content = forward.lines.join('\n') + (forward.endsWithNewline ? '\n' : '');

  // patch(1) удаляет файл, от которого ничего не осталось. Повторяем это, иначе
  // патч на удаление оставлял пустышку и ломал каждый следующий прогон.
  if (content === '' || content === '\n') {
    return {write: {file, content: null}};
  }

  return {write: {file, content}};
}

// Apple patch пишет диагностику в stdout, GNU — в stderr. Читаем оба потока, а
// если молчат оба — берём сообщение самой ошибки: при отсутствующем patch(1)
// потоков нет вовсе, и без этого пользователь видел голый ❌ без причины.
function firstDiagnosticLine(error: any): string {
  const streams = `${error.stderr?.toString() ?? ''}\n${error.stdout?.toString() ?? ''}`
    .split('\n')
    .map((line: string) => line.trim())
    .filter(Boolean);
  return streams[0] ?? (error.message ? String(error.message).split('\n')[0].trim() : '');
}

// Apply patches function
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
    const writes: PlannedWrite[] = [];
    let failure: string | null = null;

    for (const target of targets) {
      try {
        const {write} = planTarget(target);
        if (write !== null) writes.push(write);
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
        if (write.content === null) {
          rmSync(write.file, {force: true});
          continue;
        }
        mkdirSync(join(write.file, '..'), {recursive: true});
        // Разрываем hardlink на общий кеш bun: запись на месте изменила бы и его.
        rmSync(write.file, {force: true});
        writeFileSync(write.file, write.content);
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

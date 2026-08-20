#!/usr/bin/env bun

import {execFileSync} from 'child_process';
import {createHash} from 'crypto';
import {existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, rmSync} from 'fs';
import {join} from 'path';

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
  const {name, version} = packageJson;

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

    let rawPatch: string;
    try {
      rawPatch = execFileSync('diff', diffArgs, {
        encoding: 'utf-8',
        maxBuffer: 50 * 1024 * 1024,
      });
    } catch (error: any) {
      // diff: 0 — совпало, 1 — есть различия, 2 и выше — сбой.
      if (error.status !== 1) {
        const reason = (error.stderr?.toString() || error.message || '').split('\n').filter(Boolean)[0];
        throw new Error(`diff failed: ${reason}`);
      }
      rawPatch = error.stdout?.toString() ?? '';
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

// patch(1) возвращает 1 и когда патч уже в дереве, и когда файл не найден, и
// когда разошёлся контекст — по коду возврата эти случаи не различить. Поэтому
// «уже применён» проверяем отдельно: если патч ложится в обратную сторону,
// значит его изменения уже на месте. --dry-run при этом ничего не пишет на диск.
//
// --forward здесь обязателен: без него patch на ещё не применённом патче видит
// «reversed patch detected», сам переворачивает его обратно в forward и выходит
// с нулём — то есть отвечает «уже применён» вообще на что угодно.
function isAlreadyApplied(patchPath: string): boolean {
  try {
    execFileSync('patch', ['-p1', '-R', '--forward', '--dry-run', '--batch', '--silent', `--input=${patchPath}`], {
      cwd: process.cwd(),
      stdio: 'pipe',
    });
    return true;
  } catch {
    return false;
  }
}

// Заголовок от строки кода отличается только положением: удаляемая строка
// `-- /etc/config` выглядит в диффе как `--- /etc/config` и по одной регулярке
// неотличима от заголовка. Поэтому идём по патчу с учётом границ хунков —
// внутри тела хунка заголовков не бывает.
//
// Длину тела берём из счётчиков `@@ -a,b +c,d @@` и тратим их раздельно: строка
// контекста расходует обе, удаление — только старую, добавление — только новую.
//
// Заодно считаем хунки: патч без единого хунка применять нечем.
function inspectPatch(patchContent: string): {absoluteHeaders: string[]; hunks: number} {
  const absoluteHeaders: string[] = [];
  let hunks = 0;
  let oldLeft = 0;
  let newLeft = 0;

  for (const line of patchContent.split('\n')) {
    if (oldLeft > 0 || newLeft > 0) {
      if (line.startsWith('\\')) continue; // \ No newline at end of file
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
      hunks++;
      oldLeft = hunk[1] === undefined ? 1 : Number(hunk[1]);
      newLeft = hunk[2] === undefined ? 1 : Number(hunk[2]);
      continue;
    }

    // Патчи, созданные до 1.1.0, содержат в заголовках абсолютные пути. Под -p1
    // такой путь не находится, а patch ещё и раскладывает .rej по несуществующим
    // директориям — поэтому отсеиваем их до вызова patch.
    const header = line.match(/^(?:---|\+\+\+) ([^\t]+)/);
    if (header && header[1].startsWith('/') && header[1] !== '/dev/null') {
      absoluteHeaders.push(header[1]);
    }
  }

  return {absoluteHeaders, hunks};
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

    // Проверяем совпадение версии пакета с версией в патче
    const match = patchFile.match(/^(.+)\+(\d+\..+)\.patch$/);
    if (match) {
      const patchPkgName = match[1].replace(/\+/g, '/');
      const patchVersion = match[2];
      const pkgJsonPath = join('node_modules', patchPkgName, 'package.json');
      if (existsSync(pkgJsonPath)) {
        // Битый манифест не должен ронять весь прогон — проверку версии просто пропускаем.
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

    console.log(`  Applying ${patchFile}...`);

    let patchContent: string;
    try {
      patchContent = readFileSync(patchPath, 'utf-8');
    } catch (error: any) {
      failed++;
      console.log(`  ❌ ${patchFile}`);
      console.log(`     cannot read patch file: ${error.message}`);
      continue;
    }

    const {absoluteHeaders, hunks} = inspectPatch(patchContent);

    if (absoluteHeaders.length > 0) {
      failed++;
      console.log(`  ❌ ${patchFile}`);
      console.log(`     absolute path in patch header (${absoluteHeaders[0]}) — created by bunch-package < 1.1.0, recreate it with \`create\``);
      continue;
    }

    if (hunks === 0) {
      failed++;
      console.log(`  ❌ ${patchFile}`);
      console.log(`     no hunks found — the patch file is empty or truncated`);
      continue;
    }

    if (isAlreadyApplied(patchPath)) {
      applied++;
      console.log(`  ✅ ${patchFile} (already applied)`);
      continue;
    }

    try {
      execFileSync('patch', ['-p1', '--forward', '--batch', '--silent', `--input=${patchPath}`], {
        cwd: process.cwd(),
        stdio: 'pipe',
      });
      applied++;
      console.log(`  ✅ ${patchFile}`);
    } catch (error: any) {
      failed++;
      console.log(`  ❌ ${patchFile}`);
      const diagnostic = firstDiagnosticLine(error);
      if (diagnostic) {
        console.log(`     ${diagnostic}`);
      }
    }
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

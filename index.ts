#!/usr/bin/env bun

import {execSync, execFileSync} from 'child_process';
import {createHash} from 'crypto';
import {existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, rmSync} from 'fs';
import {join} from 'path';

const PATCHES_DIR = 'patches';

// Список паттернов для исключения
const EXCLUDE_PATTERNS = [
  'node_modules',
  '.git',
  '.DS_Store',
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
  // Build артефакты
  'build',
  '.gradle',
  '.transforms',
  'Pods',
  'DerivedData',
  '.cxx',
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

    writeFileSync(
      join(tempDir, 'package.json'),
      JSON.stringify({name: 'temp', version: '1.0.0'}, null, 2),
    );

    console.log(`📥 Installing clean version of ${name}@${version}...`);

    try {
      execFileSync('bun', ['add', `${name}@${version}`], {
        cwd: tempDir,
        stdio: 'pipe',
        timeout: 60000,
      });
    } catch {
      console.log(`⚠️  Trying with npm...`);
      execFileSync('npm', ['install', '--no-save', '--legacy-peer-deps', `${name}@${version}`], {
        cwd: tempDir,
        stdio: 'pipe',
        timeout: 60000,
      });
    }

    const cleanPackagePath = join(tempDir, 'node_modules', packageName);

    console.log(`🔍 Generating diff...`);

    // Строим команду diff с исключениями
    const excludeArgs = EXCLUDE_PATTERNS.map(p => `--exclude=${p}`).join(' ');

    const rawPatch = execSync(
      `diff -Naur ${excludeArgs} --no-dereference "${cleanPackagePath}" "${packagePath}" || true`,
      {
        encoding: 'utf-8',
        maxBuffer: 50 * 1024 * 1024,
      },
    );

    if (!rawPatch.trim()) {
      console.log('⚠️  No changes detected');
      console.log(`\n💡 Did you modify files in ${packagePath}?`);
      return;
    }

    // Заменяем абсолютные пути на относительные для переносимости
    const patchContent = rawPatch
      .split(cleanPackagePath).join(`a/node_modules/${packageName}`)
      .split(packagePath).join(`b/node_modules/${packageName}`);

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

// Apple patch пишет диагностику в stdout, GNU — в stderr. Читаем оба потока.
function firstDiagnosticLine(error: any): string {
  return `${error.stderr?.toString() ?? ''}\n${error.stdout?.toString() ?? ''}`
    .split('\n')
    .map((line: string) => line.trim())
    .filter(Boolean)[0] ?? '';
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

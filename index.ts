#!/usr/bin/env bun

import {execSync} from 'child_process';
import {createHash} from 'crypto';
import {existsSync, mkdirSync, readFileSync, writeFileSync, rmSync} from 'fs';
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

function createPatch(packageName: string): void {
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
      execSync(`cd "${tempDir}" && bun add ${name}@${version}`, {
        stdio: 'pipe',
        timeout: 60000,
      });
    } catch {
      console.log(`⚠️  Trying with npm...`);
      execSync(
        `cd "${tempDir}" && npm install --no-save --legacy-peer-deps ${name}@${version}`,
        {
          stdio: 'pipe',
          timeout: 60000,
        },
      );
    }

    const cleanPackagePath = join(tempDir, 'node_modules', packageName);

    console.log(`🔍 Generating diff...`);

    // Строим команду diff с исключениями
    const excludeArgs = EXCLUDE_PATTERNS.map(p => `--exclude=${p}`).join(' ');

    const patchContent = execSync(
      `diff -Naur ${excludeArgs} --no-dereference "${cleanPackagePath}" "${packagePath}" || true`,
      {
        encoding: 'utf-8',
        maxBuffer: 50 * 1024 * 1024,
      },
    );

    if (!patchContent.trim()) {
      console.log('⚠️  No changes detected');
      console.log(`\n💡 Did you modify files in ${packagePath}?`);
      return;
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

// Apply patches function
function applyPatches(): void {
  console.log(`🔧 Applying patches...`);

  if (!existsSync(PATCHES_DIR)) {
    console.log('📭 No patches directory found');
    return;
  }

  const fs = require('fs');
  const patchFiles = fs
    .readdirSync(PATCHES_DIR)
    .filter((f: string) => f.endsWith('.patch'));

  if (patchFiles.length === 0) {
    console.log('📭 No patches found');
    return;
  }

  let applied = 0;
  let failed = 0;

  for (const patchFile of patchFiles) {
    const patchPath = join(PATCHES_DIR, patchFile);
    console.log(`  Applying ${patchFile}...`);

    try {
      execSync(
        `patch -p1 --forward --batch --silent --input="${patchPath}"`,
        {
          cwd: process.cwd(),
          stdio: 'pipe',
        },
      );
      applied++;
      console.log(`  ✅ ${patchFile}`);
    } catch (error: any) {
      // Exit code 1 означает что патч уже применен (--forward)
      if (error.status === 1) {
        applied++;
        console.log(`  ✅ ${patchFile} (already applied)`);
      } else {
        failed++;
        console.log(`  ❌ ${patchFile}`);
        if (error.stderr) {
          console.log(`     ${error.stderr.toString().split('\n')[0]}`);
        }
      }
    }
  }

  console.log(`\n📊 Summary: ${applied} applied, ${failed} failed`);
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

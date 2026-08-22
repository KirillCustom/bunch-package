import {existsSync, readFileSync} from 'fs';
import {join} from 'path';
import {LOCK_FILE, withApplyLock} from './lock';
import {PatchTarget, listPatchFiles, parsePatchName} from './patch-file';
import {PATCHES_DIR, packageDirectoryOf, stripPathPrefix} from './paths';
import {executeOps} from './plan';
import {presenceOf, readTargets} from './presence';
import {appliedSequences} from './sequence';
import {recordPatches} from './state';

export function applyPatches(): void {
  console.log(`🔧 Applying patches...`);

  if (!existsSync(PATCHES_DIR)) {
    console.log('📭 No patches directory found');
    return;
  }

  const patchFiles = listPatchFiles();

  if (patchFiles.length === 0) {
    console.log('📭 No patches found');
    return;
  }

  // Замок держится ровно на время работы, а выход по коду — уже снаружи:
  // process.exit не исполняет finally, и замок пережил бы сам прогон.
  const failed = withApplyLock(LOCK_FILE, () => applyAll(patchFiles));

  if (failed > 0) {
    process.exit(1);
  }
}

// Версию сверяем по пакету из заголовков, а не по имени файла патча: при
// установке через алиас каталог называется иначе, чем пакет, и разбор имени
// файла уводил проверку к несуществующему манифесту — она молча пропадала.
function warnVersionMismatch(patchFile: string, targets: PatchTarget[]): void {
  const patchVersion = parsePatchName(patchFile)?.version;
  if (patchVersion === undefined) return;

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
function absolutePathIn(targets: PatchTarget[]): string | undefined {
  return targets
    .flatMap(t => [t.oldPath, t.newPath])
    .find((path): path is string => path !== null && path.startsWith('/'));
}

function applyAll(patchFiles: string[]): number {
  let failed = 0;

  // Патчи, оказавшиеся в дереве по итогам прогона: и легшие сейчас, и уже
  // лежавшие. Из них собирается запись о состоянии.
  const inTree: string[] = [];
  const wholeSequenceApplied = appliedSequences(patchFiles);

  for (const patchFile of patchFiles) {
    const fail = (reason: string) => {
      failed++;
      console.log(`  ❌ ${patchFile}`);
      console.log(`     ${reason}`);
    };

    if (wholeSequenceApplied.has(patchFile)) {
      inTree.push(patchFile);
      console.log(`  ✅ ${patchFile} (already applied)`);
      continue;
    }

    console.log(`  Applying ${patchFile}...`);

    const targets = readTargets(patchFile);
    if ('error' in targets) {
      fail(targets.error);
      continue;
    }

    warnVersionMismatch(patchFile, targets);

    const absolute = absolutePathIn(targets);
    if (absolute !== undefined) {
      fail(`absolute path in patch header (${absolute}) — created by bunch-package < 1.1.0, recreate it with \`create\``);
      continue;
    }

    // Весь патч считается в памяти, и пока не сойдётся целиком, на диск не идёт
    // ничего. Это и есть ответ на «применилось наполовину, а в отчёте ноль».
    const presence = presenceOf(targets);

    if (presence.kind === 'does-not-fit') {
      fail(presence.reason);
      continue;
    }

    if (presence.kind === 'in-tree') {
      inTree.push(patchFile);
      console.log(`  ✅ ${patchFile} (already applied)`);
      continue;
    }

    try {
      executeOps(presence.ops);
    } catch (error: any) {
      fail(`could not write: ${error.message}`);
      continue;
    }

    inTree.push(patchFile);
    console.log(`  ✅ ${patchFile}`);
  }

  recordPatches(inTree);

  console.log(`\n📊 Summary: ${inTree.length} applied, ${failed} failed`);

  return failed;
}

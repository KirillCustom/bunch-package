import {existsSync, readFileSync, readdirSync} from 'fs';
import {join} from 'path';
import {LOCK_FILE, withApplyLock} from './lock';
import {orderPatchFiles, parsePatch, parsePatchName} from './patch-file';
import {PATCHES_DIR, packageDirectoryOf, stripPathPrefix} from './paths';
import {PlannedOp, executeOps, planTarget} from './plan';
import {appliedSequences} from './sequence';
import {RecordedPatch, STATE_FILE, hashPatchFile, readState, writeState} from './state';

export function applyPatches(): void {
  console.log(`🔧 Applying patches...`);

  if (!existsSync(PATCHES_DIR)) {
    console.log('📭 No patches directory found');
    return;
  }

  const patchFiles = orderPatchFiles(
    readdirSync(PATCHES_DIR).filter((f: string) => f.endsWith('.patch')),
  );

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

function applyAll(patchFiles: string[]): number {
  let applied = 0;
  let failed = 0;

  // Патчи, оказавшиеся в дереве по итогам прогона: и легшие сейчас, и уже
  // лежавшие. Из них собирается запись о состоянии.
  const inTree: string[] = [];
  const wholeSequenceApplied = appliedSequences(patchFiles);

  for (const patchFile of patchFiles) {
    const patchPath = join(PATCHES_DIR, patchFile);

    const fail = (reason: string) => {
      failed++;
      console.log(`  ❌ ${patchFile}`);
      console.log(`     ${reason}`);
    };

    if (wholeSequenceApplied.has(patchFile)) {
      applied++;
      inTree.push(patchFile);
      console.log(`  ✅ ${patchFile} (already applied)`);
      continue;
    }

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
    const patchVersion = parsePatchName(patchFile)?.version;
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
      inTree.push(patchFile);
      console.log(`  ✅ ${patchFile} (already applied)`);
      continue;
    }

    try {
      executeOps(writes);
    } catch (error: any) {
      fail(`could not write: ${error.message}`);
      continue;
    }

    applied++;
    inTree.push(patchFile);
    console.log(`  ✅ ${patchFile}`);
  }

  recordState(inTree);

  console.log(`\n📊 Summary: ${applied} applied, ${failed} failed`);

  return failed;
}

// Запись обновляется и когда часть патчей не легла: она описывает дерево, а не
// прогон. Время первого попадания в дерево сохраняется, пока файл патча не
// изменился, — иначе `appliedAt` означал бы «когда последний раз запускали».
function recordState(inTree: string[]): void {
  const previous = new Map((readState()?.patches ?? []).map(patch => [patch.file, patch]));
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

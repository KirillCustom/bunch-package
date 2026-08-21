import {existsSync, readFileSync, readdirSync} from 'fs';
import {join} from 'path';
import {LOCK_FILE, withApplyLock} from './lock';
import {invertTarget, orderPatchFiles, parsePatch, parsePatchName} from './patch-file';
import {PATCHES_DIR} from './paths';
import {executeOps, planTarget} from './plan';
import {recordPatches} from './state';

// Патчи одного пакета — как коммиты: чтобы переделать не последний, надо сперва
// снять те, что легли поверх него. Это и делает rebase, и ровно это же значит
// `--rebase` у patch-package (проверено по его исходникам, а не по названию).
//
// Откат — применение перевёрнутого патча тем же кодом, что и обычное
// применение: см. invertTarget().
export function rebasePatches(packageName: string, target: string): void {
  if (!existsSync(PATCHES_DIR)) {
    throw new Error(`No ${PATCHES_DIR}/ directory — there is nothing to rebase`);
  }

  const all = orderPatchFiles(readdirSync(PATCHES_DIR).filter(file => file.endsWith('.patch')));
  const mine = all.filter(file => parsePatchName(file)?.packageDir === packageName);

  if (mine.length === 0) {
    throw new Error(`No patches found for ${packageName} in ${PATCHES_DIR}/`);
  }

  const keep = resolveTarget(mine, target, packageName);
  const undo = mine.slice(keep).reverse(); // снимаем сверху вниз

  console.log(`🔧 Rebasing ${packageName} onto ${keep === 0 ? 'nothing' : mine[keep - 1]}...`);

  const removed = withApplyLock(LOCK_FILE, () => unApply(undo));

  if (removed === undo.length) {
    // Всё, что должно было уйти, ушло — записываем оставшееся.
    recordPatches(all.filter(file => !undo.includes(file)));
  }

  console.log('');
  if (keep === 0) {
    console.log(`Now edit node_modules/${packageName}, then run:`);
    console.log(`  bunch-package create ${packageName} --append <name>   to insert a patch before the others`);
  } else {
    console.log(`Now edit node_modules/${packageName}, then run:`);
    console.log(`  bunch-package create ${packageName}                   to update ${mine[keep - 1]}`);
    console.log(`  bunch-package create ${packageName} --append <name>   to insert a patch after it`);
  }
  console.log(`  bunch-package apply                                  to put the rest back`);
}

// Цель называют как удобно: именем файла, номером в последовательности, меткой
// или нулём — как у patch-package, чтобы привычка переносилась вместе с патчами.
function resolveTarget(mine: string[], target: string, packageName: string): number {
  if (target === '0') return 0;

  const index = mine.findIndex(file => {
    const parsed = parsePatchName(file);
    if (file === target || join(PATCHES_DIR, file) === target) return true;
    if (parsed === null || parsed.sequence === 0) return false;

    const number = String(parsed.sequence).padStart(3, '0');
    // Номер, метка и то, как патч выглядит в имени файла — `001+initial`.
    return (
      parsed.label === target ||
      `${number}+${parsed.label}` === target ||
      parsed.sequence === Number(target)
    );
  });

  if (index === -1) {
    throw new Error(
      `Could not find patch ${target} for ${packageName}. Its patches are:\n   ${mine.join('\n   ')}\n` +
        `   (or 0 to un-apply all of them)`,
    );
  }

  return index + 1; // сколько патчей остаётся лежать
}

function unApply(files: string[]): number {
  let removed = 0;

  for (const file of files) {
    const targets = parsePatch(readFileSync(join(PATCHES_DIR, file), 'utf-8'));

    if (targets.length === 0) {
      console.log(`  ❌ ${file}`);
      console.log(`     no hunks found — the patch file is empty or truncated`);
      break;
    }

    // Сперва спрашиваем про исходный патч, а не про перевёрнутый: пустой план
    // на прямое применение означает, что изменения патча в дереве. Спрашивать
    // то же самое у перевёрнутого нельзя — у патча, который только дописывает
    // строки, прямое применение сходится и во второй раз.
    let inTree: boolean;
    try {
      inTree = targets.flatMap(target => planTarget(target)).length === 0;
    } catch (error: any) {
      console.log(`  ❌ ${file}`);
      console.log(`     ${error.message}`);
      console.log(`     The tree matches neither side of this patch, so it cannot be un-applied.`);
      break;
    }

    if (!inTree) {
      console.log(`  ➖ ${file} (was not in the tree)`);
      removed++;
      continue;
    }

    // Как и при применении: сначала считаем весь патч, потом пишем. Половина
    // снятого патча — состояние, из которого не выбраться.
    let ops;
    try {
      ops = targets.map(invertTarget).flatMap(target => planTarget(target, undefined, true));
    } catch (error: any) {
      console.log(`  ❌ ${file}`);
      console.log(`     ${error.message}`);
      break;
    }

    executeOps(ops);
    console.log(`  ↩️  ${file}`);
    removed++;
  }

  return removed;
}

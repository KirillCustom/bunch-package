import {existsSync, readFileSync} from 'fs';
import {join} from 'path';
import {lockFile, withApplyLock} from './lock';
import {applyHunks} from './hunks';
import {invertTarget, listPatchFiles, parsePatchName, PatchTarget} from './patch-file';
import {patchesAppliedByBun} from './foreign';
import {patchesDirectory} from './paths';
import {PlannedOp, executeOps, planTarget, splitContent} from './plan';
import {outsideProjectReason, packagesOutsideProject, presenceOf, readTargets} from './presence';
import {recordPatches, recordedPatches} from './state';

// Патчи одного пакета — как коммиты: чтобы переделать не последний, надо сперва
// снять те, что легли поверх него. Это и делает rebase, и ровно это же значит
// `--rebase` у patch-package (проверено по его исходникам, а не по названию).
//
// Откат — применение перевёрнутого патча тем же кодом, что и обычное
// применение: см. invertTarget().
export function rebasePatches(packageName: string, target: string): void {
  if (!existsSync(patchesDirectory())) {
    throw new Error(`No ${patchesDirectory()}/ directory — there is nothing to rebase`);
  }

  const all = listPatchFiles();
  const mine = all.filter(file => parsePatchName(file)?.packageDir === packageName);

  if (mine.length === 0) {
    throw new Error(`No patches found for ${packageName} in ${patchesDirectory()}/`);
  }

  const keep = resolveTarget(mine, target, packageName);
  const undo = mine.slice(keep).reverse(); // снимаем сверху вниз

  console.log(`🔧 Rebasing ${packageName} onto ${keep === 0 ? 'nothing' : mine[keep - 1]}...`);

  const removed = withApplyLock(lockFile(), () => unApply(undo));

  if (removed < undo.length) {
    // Часть патчей снять не удалось. Те, что выше сорвавшегося, уже сняты, сам
    // он и всё под ним — на месте. Выходим с ошибкой: молча вернуть ноль после
    // напечатанного ❌ значит соврать вызывающему, включая CI.
    console.log('');
    console.log(`⚠️  Stopped after ${removed} of ${undo.length}. Everything above ${undo[removed]} is off; it and the rest are untouched.`);
    process.exit(1);
  }

  // Всё, что должно было уйти, ушло — записываем оставшееся. Оставшееся считаем
  // от самой записи, а не от списка файлов в patches/: файл на диске не значит,
  // что патч в дереве, и после rebase в запись попадали патчи чужих пакетов,
  // которых никто никогда не применял.
  recordPatches([...recordedPatches().keys()].filter(file => !undo.includes(file)));

  const next: [string, string][] = keep === 0
    ? [
        [`bunch-package create ${packageName} --append <name>`, 'to insert a patch before the others'],
        ['bunch-package apply', 'to put the rest back'],
      ]
    : [
        [`bunch-package create ${packageName}`, `to update ${mine[keep - 1]}`],
        [`bunch-package create ${packageName} --append <name>`, 'to insert a patch after it'],
        ['bunch-package apply', 'to put the rest back'],
      ];

  // Ширину колонки считаем, а не подгоняем руками: имя пакета бывает любым.
  const width = Math.max(...next.map(([command]) => command.length)) + 3;

  console.log('');
  console.log(`Now edit node_modules/${packageName}, then run:`);
  for (const [command, purpose] of next) console.log(`  ${command.padEnd(width)}${purpose}`);
}

// Снять всё — отдельная команда, а не rebase с особым аргументом: rebase просит
// пакет, а «снять все патчи проекта» пакета не называет. У patch-package это
// `--reverse`, и повод тот же: вернуть node_modules к тому, что поставил
// установщик, не переустанавливая их.
export function reverseAll(): void {
  const all = listPatchFiles().filter(file => !patchesAppliedByBun().has(file));

  if (all.length === 0) {
    console.log('📭 No patches to un-apply');
    return;
  }

  console.log(`🔧 Un-applying ${all.length} patch(es)...`);

  // Сверху вниз: патчи последовательности лежат друг на друге.
  const undo = [...all].reverse();
  const removed = withApplyLock(lockFile(), () => unApply(undo));

  recordPatches([...recordedPatches().keys()].filter(file => !undo.slice(0, removed).includes(file)));

  console.log('');
  console.log(`📊 ${removed} of ${undo.length} un-applied`);

  if (removed < undo.length) {
    console.log(`⚠️  Stopped at ${undo[removed]}; it and everything under it are untouched.`);
    process.exit(1);
  }
}

// Цель называют как удобно: именем файла, номером в последовательности, меткой
// или нулём — как у patch-package, чтобы привычка переносилась вместе с патчами.
function resolveTarget(mine: string[], target: string, packageName: string): number {
  if (target === '0') return 0;

  const index = mine.findIndex(file => {
    const parsed = parsePatchName(file);
    if (file === target || join(patchesDirectory(), file) === target) return true;
    if (parsed === null || parsed.sequence === 0) return false;

    // Номер, метка и то, как патч выглядит в имени файла — `001+initial`.
    const number = String(parsed.sequence).padStart(3, '0');
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
    const targets = readTargets(file);
    if ('error' in targets) {
      console.log(`  ❌ ${file}`);
      console.log(`     ${targets.error}`);
      break;
    }

    // Снятие патча — такая же запись в дерево, как и его применение, и через
    // общий стор оно точно так же уехало бы в чужие проекты.
    const outsideProject = packagesOutsideProject(targets);
    if (outsideProject.length > 0) {
      console.log(`  ❌ ${file}`);
      console.log(`     ${outsideProjectReason(outsideProject[0])}`);
      break;
    }

    // Спрашиваем про исходный патч, а не про перевёрнутый: пустой план на
    // прямое применение означает, что изменения патча в дереве. Спрашивать то
    // же самое у перевёрнутого нельзя — у патча, который только дописывает
    // строки, прямое применение сходится и во второй раз.
    const presence = presenceOf(targets);

    if (presence.kind === 'does-not-fit') {
      console.log(`  ❌ ${file}`);
      console.log(`     ${presence.reason}`);
      console.log(`     The tree matches neither side of this patch, so it cannot be un-applied.`);
      break;
    }

    if (presence.kind === 'not-in-tree') {
      console.log(`  ➖ ${file} (was not in the tree)`);
      removed++;
      continue;
    }

    // Как и при применении: сначала считаем весь патч, потом пишем. Половина
    // снятого патча — состояние, из которого не выбраться.
    let ops: PlannedOp[] = [];
    let inexact: string | null = null;

    try {
      for (const target of targets) {
        const planned = planTarget(invertTarget(target), undefined, true);
        inexact ??= firstInexact(planned, target);
        ops.push(...planned);
      }
    } catch (error: any) {
      console.log(`  ❌ ${file}`);
      console.log(`     ${error.message}`);
      break;
    }

    if (inexact !== null) {
      console.log(`  ❌ ${file}`);
      console.log(`     ${inexact} cannot be restored exactly.`);
      console.log(`     The patch is the only record of the lines it removed, and it does not`);
      console.log(`     match them byte for byte — trailing whitespace or CRLF, most likely.`);
      console.log(`     Writing an approximation would put that difference into the next patch.`);
      break;
    }

    executeOps(ops);
    console.log(`  ↩️  ${file}`);
    removed++;
  }

  return removed;
}

// Проверка себя: применив исходный патч к тому, что мы собираемся записать,
// обязаны получить ровно то, что лежит сейчас. Иначе восстановление неточное.
//
// Записать «почти то же самое» нельзя: эта разница уедет в следующий патч,
// который create посчитает от эталона.
//
// Проверка эта — о содержимом строк, а не об их переводах: разницу в `\r` она
// не видит, потому что повторное применение прячет её обратно. За переводы
// строки отвечает applyHunks(matchFileEndings) — см. комментарий там.
function firstInexact(ops: PlannedOp[], original: PatchTarget): string | null {
  // Переименования проверять так нельзя: содержимое к этому моменту лежит по
  // старому пути, а op.file называет новый.
  if (original.renameFrom !== null) return null;

  for (const op of ops) {
    if (op.kind !== 'write') continue;

    const there = existsSync(op.file);
    const {lines, endsWithNewline} = splitContent(op.content);
    const forward = applyHunks(lines, endsWithNewline, original.hunks, false);

    if ('error' in forward) return op.file;
    const rebuilt = forward.lines.join('\n') + (forward.endsWithNewline ? '\n' : '');

    // Файла нет — значит исходный патч его удалял, и от содержимого не должно
    // остаться ничего. Пустой результат бывает и `\n`: ровно так же его
    // трактует planContentChange, когда решает удалить файл.
    if (!there) {
      if (rebuilt !== '' && rebuilt !== '\n') return op.file;
      continue;
    }

    if (rebuilt !== readFileSync(op.file, 'utf-8')) return op.file;
  }

  return null;
}

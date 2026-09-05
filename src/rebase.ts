import {existsSync, readFileSync} from 'fs';
import {join} from 'path';
import {lockFile, withApplyLock} from './lock';
import {applyHunks} from './hunks';
import {invertTarget, listPatchFiles, parsePatchName, patchNameKey, patchesOfPackage, PatchTarget} from './patch-file';
import {firstPathOutsideNodeModules, foreignPatchReason, patchesAppliedByBun} from './foreign';
import {installedPackagePath, patchesDirectory} from './paths';
import {PlannedOp, executeOps, planTarget, splitContent} from './plan';
import {outsideProjectReason, packagesOutsideProject, patchTargetDirectory, presenceOf, readTargets} from './presence';
import {recordPatches, recordedPatches} from './state';
import {readManifest, validatePackageName} from './create';

// Патчи одного пакета — как коммиты: чтобы переделать не последний, надо сперва
// снять те, что легли поверх него. Это и делает rebase, и ровно это же значит
// `--rebase` у patch-package (проверено по его исходникам, а не по названию).
//
// Откат — применение перевёрнутого патча тем же кодом, что и обычное
// применение: см. invertTarget().
export function rebasePatches(packageName: string, target: string): void {
  validatePackageName(packageName);

  if (!existsSync(patchesDirectory())) {
    throw new Error(`No ${patchesDirectory()}/ directory — there is nothing to rebase`);
  }

  // Аргумент — это каталог в node_modules; им же назван файл патча. Файлы,
  // созданные до 1.17.0, названы по manifest.name — их имя тоже понимаем, см.
  // patchNameKey. Имя из манифеста как аргумент тоже принимается: каталога с
  // таким именем нет, и тогда ключом становится сам аргумент.
  const packagePath = installedPackagePath(packageName);
  const installed = existsSync(packagePath);
  let manifestName: string | null = null;

  if (installed) {
    try {
      manifestName = readManifest(packagePath).name;
    } catch {
      // Битый манифест — не повод не откатывать: патчи от этого из дерева не
      // исчезают. Говорим, какой файл не читается, и ищем по путям внутри патчей.
      console.log(`⚠️  Cannot read node_modules/${packageName}/package.json — falling back to path-based patch search`);
    }
  }

  const all = listPatchFiles();
  const patchDir = manifestName === null ? packageName : patchNameKey(packageName, manifestName, all);
  let mine = patchesOfPackage(all, patchDir);

  // Один manifest.name бывает у двух каталогов сразу: пакет ставят и напрямую, и
  // через алиас — ровно ради двух версий. Пока набор собирался по одному лишь
  // имени, `rebase is-number 0` снимал заодно патчи соседнего каталога и
  // рапортовал про него же (TSK-44). Просеиваем по тому, куда патч ложится, —
  // это написано в нём самом.
  if (installed) {
    mine = mine.filter(file => {
      const directory = patchTargetDirectory(file);
      return directory === null || directory === packageName;
    });
  }

  // Манифест не прочитан, а патч назван по нему — по имени его теперь не найти,
  // зато путь внутри патча ведёт прямо в наш каталог.
  if (mine.length === 0 && installed && manifestName === null) {
    mine = all.filter(file => patchTargetDirectory(file) === packageName);
  }

  // Аргументом дали имя из манифеста, а каталог называется иначе: `rebase
  // is-number 0` при `mynum@npm:is-number`. Ищем среди каталогов, у которых
  // патчи есть, — их единицы, и ответ однозначен, в отличие от обхода всего
  // node_modules: один manifest.name бывает у двух каталогов сразу.
  if (mine.length === 0 && !installed) {
    const directories = [...new Set(all.map(patchTargetDirectory))].filter(
      (directory): directory is string => directory !== null && manifestNameOf(directory) === packageName,
    );

    if (directories.length > 1) {
      throw new Error(
        `${packageName} is installed as ${directories.join(' and ')} — name the directory you mean.`,
      );
    }
    if (directories.length === 1) {
      mine = all.filter(file => patchTargetDirectory(file) === directories[0]);
    }
  }

  if (mine.length === 0) {
    throw new Error(`No patches found for ${packageName} in ${patchesDirectory()}/`);
  }

  const keep = resolveTarget(mine, target, packageName);
  const undo = mine.slice(keep).reverse(); // снимаем сверху вниз

  // Каталог для подсказок — тот, куда патч ложится, а не тот, как его назвали.
  const dirName = patchTargetDirectory(mine[0]) ?? packageName;

  console.log(`🔧 Rebasing ${dirName} onto ${keep === 0 ? 'nothing' : mine[keep - 1]}...`);

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
        [`bunch-package create ${dirName} --append <name>`, 'to insert a patch before the others'],
        ['bunch-package apply', 'to put the rest back'],
      ]
    : [
        [`bunch-package create ${dirName}`, `to update ${mine[keep - 1]}`],
        [`bunch-package create ${dirName} --append <name>`, 'to insert a patch after it'],
        ['bunch-package apply', 'to put the rest back'],
      ];

  // Ширину колонки считаем, а не подгоняем руками: имя пакета бывает любым.
  const width = Math.max(...next.map(([command]) => command.length)) + 3;

  console.log('');
  console.log(`Now edit node_modules/${dirName}, then run:`);
  for (const [command, purpose] of next) console.log(`  ${command.padEnd(width)}${purpose}`);
}

// Имя пакета в манифесте установленного каталога. Битый или отсутствующий
// манифест — это не ответ «совпало», поэтому null, а не бросок: спрашивают в
// поиске, где отказ одного каталога не должен решать за все.
function manifestNameOf(directory: string): string | null {
  const path = installedPackagePath(directory);
  if (!existsSync(path)) return null;

  try {
    return readManifest(path).name;
  } catch {
    return null;
  }
}

// Снять всё — отдельная команда, а не rebase с особым аргументом: rebase просит
// пакет, а «снять все патчи проекта» пакета не называет. У patch-package это
// `--reverse`, и повод тот же: вернуть node_modules к тому, что поставил
// установщик, не переустанавливая их.
export function reverseAll(): void {
  // Список читается один раз: внутри он разбирает манифест — а в монорепо ещё
  // и корневой, — и спрошенный на каждый файл он перечитывал бы их столько раз,
  // сколько в проекте патчей. Так же он вынесен в apply и в status.
  const byBun = patchesAppliedByBun();
  const all = listPatchFiles().filter(file => !byBun.has(file));

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

    // Патч не нашего формата: у `bun patch` пути от корня пакета, и, срезав
    // `a/`, откат взялся бы за файлы самого проекта. Пока эта проверка стояла
    // только в apply, так и было — измерено: чужой патч, не записанный в
    // `patchedDependencies`, возвращал `index.js` проекта к дореверсной строке,
    // и `reverse`, и `rebase` печатали при этом успех. Фильтр по манифесту в
    // reverseAll прикрывает лишь тех, кто в манифесте записан, а имя файла не
    // говорит о формате ничего: его переименовывают руками.
    const foreign = firstPathOutsideNodeModules(targets);
    if (foreign !== undefined) {
      console.log(`  ❌ ${file}`);
      console.log(`     ${foreignPatchReason(foreign)}`);
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
    // Двоичную запись этой проверкой не проверить: у секции нет хунков, чтобы
    // приложить их обратно. Её сходимость держится на git-хешах сторон, которые
    // planTarget сверяет до всякой записи.
    if (typeof op.content !== 'string') continue;

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

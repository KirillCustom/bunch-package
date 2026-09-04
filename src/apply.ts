import {existsSync, readFileSync} from 'fs';
import {join} from 'path';
import {inProduction, missingPackages, skipsMissingPackage} from './dev';
import {firstPathOutsideNodeModules, foreignPatchReason, patchesAppliedByBun} from './foreign';
import {lockFile, withApplyLock} from './lock';
import {PatchTarget, formatPatchName, listPatchFiles, parsePatchName, patchesOfPackage} from './patch-file';
import {patchesDirectory, packageDirectoryOf, resolvePackagePath, stripPathPrefix} from './paths';
import {executeOps} from './plan';
import {outsideProjectReason, packagesOutsideProject, presenceOf, readTargets} from './presence';
import {appliedSequences} from './sequence';
import {conflictingWorkspacePatch, sharedConflictReason} from './shared';
import {RecordedPatch, patchBodyChanged, recordPatches, recordedPatches, unchangedTreeWitness} from './state';

export function applyPatches(errorOnWarn = false): void {
  console.log(`🔧 Applying patches...`);

  if (!existsSync(patchesDirectory())) {
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
  const {failed, warned} = withApplyLock(lockFile(), () => applyAll(patchFiles));

  // Предупреждение — это «патч лёг, но что-то не сходится»: чаще всего версия
  // пакета уехала. Для CI такое иногда должно валить сборку, но решает это
  // вызывающий, а не мы: по умолчанию установка из-за расхождения не падает.
  if (failed > 0 || (errorOnWarn && warned > 0)) {
    process.exit(1);
  }
}

// Каталоги пакетов, которых касается патч. Спрашивают двое: сверка версии — у
// всех сразу, отказ по устаревшей записи — у первого, чтобы назвать в совете
// то, что переустанавливать.
function packageDirsOf(targets: PatchTarget[]): string[] {
  return [
    ...new Set(
      targets
        .map(t => packageDirectoryOf(stripPathPrefix(t.newPath ?? t.oldPath ?? '')))
        .filter((dir): dir is string => dir !== null),
    ),
  ];
}

// Патч того же пакета, написанный ровно для установленной версии. Пока такого
// файла нет, «версия уехала» — обычное дело: патч часто ложится и на соседнюю
// версию, и patch-package с нами тут согласен. А вот когда он есть, набор
// несогласован: два файла для одного пакета, один из них для версии, которой в
// дереве нет. Оба всё равно применятся, и в дереве окажутся обе правки — про
// это и надо сказать одной строкой, а не двумя разрозненными (TSK-41).
function patchForInstalledVersion(patchFile: string, patchFiles: string[], installed: string): string | undefined {
  const mine = parsePatchName(patchFile);
  if (mine === null) return undefined;

  // Сам себя патч тут не найдёт: сюда приходят только те, чья версия с
  // установленной уже разошлась. Проверять имя ещё раз — второй замок на той же
  // двери; мутация «убрать её» не покраснела ни одним тестом.
  return patchesOfPackage(patchFiles, mine.packageDir).find(file => parsePatchName(file)?.version === installed);
}

// Версию сверяем по пакету из заголовков, а не по имени файла патча: при
// установке через алиас каталог называется иначе, чем пакет, и разбор имени
// файла уводил проверку к несуществующему манифесту — она молча пропадала.
function warnVersionMismatch(patchFile: string, patchFiles: string[], targets: PatchTarget[]): number {
  const parsed = parsePatchName(patchFile);
  const patchVersion = parsed?.version;
  if (patchVersion === undefined) return 0;

  let warnings = 0;

  for (const dir of packageDirsOf(targets)) {
    // Манифест читается там, где пакет установлен: в монорепо это может быть
    // node_modules корня, а не воркспейса.
    const pkgJsonPath = resolvePackagePath(`${dir}/package.json`);
    if (!existsSync(pkgJsonPath)) continue;

    // Битый манифест не должен ронять весь прогон — проверку просто пропускаем.
    let installedVersion: string | undefined;
    try {
      installedVersion = JSON.parse(readFileSync(pkgJsonPath, 'utf-8')).version;
    } catch {
      console.log(`  ⚠️  ${patchFile} — cannot read ${pkgJsonPath}, skipping version check`);
      warnings++;
    }

    if (installedVersion !== undefined && installedVersion !== patchVersion) {
      const current = patchForInstalledVersion(patchFile, patchFiles, installedVersion);

      if (current === undefined) {
        console.log(`  ⚠️  ${patchFile} — version mismatch (patch: ${patchVersion}, installed: ${installedVersion})`);
      } else {
        // Пакет называем так, как он назван в имени патча: при установке через
        // алиас каталог в дереве зовётся иначе, и человек ищет файл по имени.
        console.log(`  ⚠️  ${patchFile} — written for ${parsed!.packageDir} ${patchVersion}, but ${installedVersion} is installed`);
        console.log(`      and ${current} is written for it. Both are applied, so the tree ends up`);
        console.log(`      with both changes. Delete this file, or move its changes into ${current}.`);
      }
      warnings++;
    }
  }

  return warnings;
}

// Патчи до 1.1.0 писали в заголовки абсолютные пути. Под -p1 первый компонент
// срезается, и `/Users/...` превращается в `Users/...` — путь, которого в
// проекте нет. Ловим это отдельно, чтобы сказать пользователю правду.
function absolutePathIn(targets: PatchTarget[]): string | undefined {
  return targets
    .flatMap(t => [t.oldPath, t.newPath])
    .find((path): path is string => path !== null && path.startsWith('/'));
}

// Файл патча переписали после того, как он лёг: так выглядит переключение ветки
// с другой версией того же патча. Прежняя правка при этом осталась в дереве, и
// новый патч лёг бы поверх неё — в файле оказались бы обе. У patch-package на
// этом жалобы #487 и #557, и там это кончается отказом; у нас до сих пор
// проходило молча, с `✅` и `1 applied` (NOT-30).
//
// `witness` — файл, который прежний патч оставил и которого с тех пор не
// касались. Пока он такой, какой записан, прежняя правка доказуемо в дереве, и
// это уже утверждение о дереве, а не о записи ([[DEC-11]]). Его нет — значит
// дерево трогали или пакет переустановили: тогда говорим вслух, но не отказываем,
// потому что отказ здесь встал бы поперёк обычной работы.
type StaleRecord = {appliedAt: string; witness: string | null};

function staleRecord(record: RecordedPatch | undefined, patchFile: string): StaleRecord | null {
  if (record === undefined) return null;

  let raw: Buffer;
  try {
    raw = readFileSync(join(patchesDirectory(), patchFile));
  } catch {
    return null; // файл только что читал разбор; если он исчез, скажет об этом он
  }

  if (!patchBodyChanged(record, raw, raw.toString('utf-8'))) return null;

  return {appliedAt: record.appliedAt, witness: unchangedTreeWitness(record)};
}

// Что человек об этом прочтёт. Совет один — переустановить пакет: `reverse` снял
// бы патч, который лежит в patches/ сейчас, а в дереве другой, и стало бы хуже.
//
// `mixes` отличает отказ «класть поверх прежнего не будем» от объяснения, зачем
// это сказано при патче, который и так не лёг: во втором случае ничего не
// смешалось бы, и обещать это было бы неправдой.
function staleNote(stale: StaleRecord, packageDirs: string[], mixes: boolean): string {
  const changed = `the patch file changed since it was applied on ${stale.appliedAt}`;

  if (stale.witness === null) {
    return `${changed} —\n     the previous version's changes may still be in node_modules`;
  }

  const dir = packageDirs[0];
  const reinstall =
    dir === undefined
      ? 'Reinstall the package before applying this patch.'
      : `Reinstall it first: delete ${dir}, then run \`bun install\``;

  return (
    `${changed}, and\n` +
    `     ${stale.witness} is still the file that version left in the tree.\n` +
    (mixes ? `     Applying this one on top of it would mix the two versions.\n` : '') +
    `     ${reinstall}`
  );
}

function applyAll(patchFiles: string[]): {failed: number; warned: number} {
  let failed = 0;
  let warned = 0;

  // Патчи, оказавшиеся в дереве по итогам прогона: и легшие сейчас, и уже
  // лежавшие. Из них собирается запись о состоянии.
  const inTree: string[] = [];
  // Патчи, чью запись отказ обязан пережить: в дереве лежит прежняя их версия,
  // и забыть об этом значит применить их поверх при следующем же `bun install`.
  const keepRecord: string[] = [];
  const byBun = patchesAppliedByBun();
  const wholeSequenceApplied = appliedSequences(patchFiles);
  // Запись читается один раз на прогон: спрашивают её на каждый патч, а лежит
  // она одна на проект.
  const recorded = recordedPatches();

  for (const patchFile of patchFiles) {
    const fail = (reason: string) => {
      failed++;
      console.log(`  ❌ ${patchFile}`);
      console.log(`     ${reason}`);
    };

    // Патч, записанный в `patchedDependencies`, применяет сам bun при
    // установке. Это не отказ и не наше дело — просто говорим, чей он.
    if (byBun.has(patchFile)) {
      console.log(`  ⏭  ${patchFile} — bun applies this one itself (patchedDependencies)`);
      continue;
    }

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

    warned += warnVersionMismatch(patchFile, patchFiles, targets);

    const absolute = absolutePathIn(targets);
    if (absolute !== undefined) {
      fail(`absolute path in patch header (${absolute}) — created by bunch-package < 1.1.0, recreate it with \`create\``);
      continue;
    }

    // Пути не под node_modules/ — это патч не нашего формата. У `bun patch`
    // они от корня пакета, и, срезав `a/`, мы взялись бы за файлы проекта.
    const outside = firstPathOutsideNodeModules(targets);
    if (outside !== undefined) {
      fail(foreignPatchReason(outside));
      continue;
    }

    // Пакета нет на диске — про это и сообщаем, вместо «хунк не подошёл». А
    // дев-патч на production-установке пропускаем: пакет там и не должен быть.
    const missing = missingPackages(targets);
    if (missing.length > 0) {
      if (skipsMissingPackage(patchFile)) {
        console.log(`  ⏭  ${patchFile} — dev-only, and ${missing[0]} is not installed`);
        continue;
      }

      fail(`${missing[0]} is not installed`);
      const parsed = parsePatchName(patchFile);
      if (inProduction() && parsed !== null && !parsed.devOnly) {
        console.log(`     If it is a dev dependency, rename this patch to ${formatPatchName({...parsed, devOnly: true})}`);
      }
      continue;
    }

    // Пакет лежит не там, где написано: node_modules/<pkg> — симлинк в общий
    // стор bun. Писать туда — менять пакет всем проектам на машине; проверено,
    // соседний проект приезжает с чужой заплатой. Отказываемся, как отказывается
    // сам bun, когда видит путь сквозь общий стор.
    const outsideProject = packagesOutsideProject(targets);
    if (outsideProject.length > 0) {
      fail(outsideProjectReason(outsideProject[0]));
      continue;
    }

    // Каталог пакета общий с соседним воркспейсом, и патчи у них разные. Дерева,
    // которое устроило бы обоих, не существует; молча положить своё — значит
    // подменить пакет соседу. Так делает patch-package, и это измерено.
    const conflict = conflictingWorkspacePatch(patchFile, targets);
    if (conflict !== null) {
      fail(sharedConflictReason(conflict));
      continue;
    }

    // Весь патч считается в памяти, и пока не сойдётся целиком, на диск не идёт
    // ничего. Это и есть ответ на «применилось наполовину, а в отчёте ноль».
    const presence = presenceOf(targets);
    const stale = staleRecord(recorded.get(patchFile), patchFile);

    if (presence.kind === 'does-not-fit') {
      // Тот самый случай, ради которого жалобы и заведены: хунк не сходится не
      // потому, что патч плох, а потому, что в дереве лежит прежняя его версия.
      if (stale !== null) keepRecord.push(patchFile);
      fail(stale === null ? presence.reason : `${presence.reason}\n     ${staleNote(stale, packageDirsOf(targets), false)}`);
      continue;
    }

    // Патч уже в дереве — про запись молчим. Дерево здесь совпадает и с новым
    // файлом патча, и с тем, что оставил `create`: он переписывает патч, не
    // трогая node_modules, и предупреждать после каждой правки своего же патча
    // значило бы приучить не читать предупреждения.
    if (presence.kind === 'in-tree') {
      inTree.push(patchFile);
      console.log(`  ✅ ${patchFile} (already applied)`);
      continue;
    }

    if (stale !== null) {
      const note = staleNote(stale, packageDirsOf(targets), true);

      if (stale.witness !== null) {
        keepRecord.push(patchFile);
        fail(note);
        continue;
      }

      warned++;
      console.log(`  ⚠️  ${patchFile} — ${note}`);
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

  recordPatches(inTree, {keepAsRecorded: keepRecord});

  console.log(`\n📊 Summary: ${inTree.length} applied, ${failed} failed`);

  return {failed, warned};
}

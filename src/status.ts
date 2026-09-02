import {existsSync, readFileSync} from 'fs';
import {join} from 'path';
import {missingPackages, skipsMissingPackage} from './dev';
import {firstPathOutsideNodeModules, patchesAppliedByBun} from './foreign';
import {listPatchFiles, patchHeaderSummary, splitPatchHeader} from './patch-file';
import {patchesDirectory} from './paths';
import {Presence, outsideProjectReason, packagesOutsideProject, presenceOf, readTargets} from './presence';
import {appliedSequences} from './sequence';
import {RecordedPatch, STATE_FILE, hashPatchBody, hashPatchFile, readState, recordedPatches} from './state';

// Что с патчем прямо сейчас. Определяется по дереву, а не по записи: запись
// говорит, что было, а спрашивают — что есть. Сам расчёт — общий с apply.
type Shown = Presence | {kind: 'unreadable'; reason: string} | {kind: 'dev-only'; missing: string};

function shownPresence(patchFile: string, wholeSequenceApplied: Set<string>): Shown {
  if (wholeSequenceApplied.has(patchFile)) return {kind: 'in-tree'};

  const targets = readTargets(patchFile);
  if ('error' in targets) return {kind: 'unreadable', reason: targets.error};

  const outside = firstPathOutsideNodeModules(targets);
  if (outside !== undefined) {
    return {kind: 'does-not-fit', reason: `${outside} is not inside node_modules/ — this patch is not ours`};
  }

  const outsideProject = packagesOutsideProject(targets);
  if (outsideProject.length > 0) {
    return {kind: 'does-not-fit', reason: outsideProjectReason(outsideProject[0])};
  }

  // На production-установке пакета дев-патча нет и не должно быть — это не
  // пропажа, а ровно то, чего от такой установки ждут. Ровно так же на него
  // смотрит apply.
  const missing = missingPackages(targets);
  if (missing.length > 0 && skipsMissingPackage(patchFile)) {
    return {kind: 'dev-only', missing: missing[0]};
  }

  return presenceOf(targets);
}

function describeRecord(record: RecordedPatch | undefined, patchFile: string): string {
  if (record === undefined) return 'not in the state file';

  const path = join(patchesDirectory(), patchFile);
  if (existsSync(path) && hashPatchFile(path) !== record.sha256) {
    // Заголовок дерева не касается. Сказать про него «патч переписали» значило
    // бы звать человека разбираться туда, где менялось одно объяснение.
    if (record.bodySha256 !== undefined && record.bodySha256 === hashPatchBody(path)) {
      return `only its header changed since it was applied on ${record.appliedAt}`;
    }
    return `the patch file changed since it was applied on ${record.appliedAt}`;
  }
  return `applied ${record.appliedAt}`;
}

// Зачем этот патч существует — если в файле написано. Без этого имя файла
// говорит только про пакет и версию, и `status` отвечает на «что в дереве», но
// не на «что это вообще такое».
function headerLine(patchFile: string): string | null {
  const path = join(patchesDirectory(), patchFile);
  if (!existsSync(path)) return null;

  try {
    return patchHeaderSummary(splitPatchHeader(readFileSync(path, 'utf-8')).header);
  } catch {
    return null; // нечитаемый файл — забота presenceOf, а не этой строки
  }
}

export function showStatus(): void {
  const patchFiles = listPatchFiles();

  // Запись читается до всякого выхода: патчей может не остаться вовсе, а их
  // изменения — лежать в node_modules. Промолчать об этом было бы худшим
  // ответом на вопрос «что сейчас в дереве».
  const state = readState();
  const recorded = recordedPatches(state);

  if (patchFiles.length === 0 && recorded.size === 0) {
    console.log(existsSync(patchesDirectory()) ? '📭 No patches found' : '📭 No patches directory found');
    return;
  }

  // Патчи bun лежат в том же каталоге, но применяет их установщик. Считать их
  // своими нельзя, а молчать о них — значит отвечать не на весь вопрос «что
  // сейчас в дереве».
  const byBun = patchesAppliedByBun();
  const ours = patchFiles.filter(file => !byBun.has(file));
  const wholeSequenceApplied = appliedSequences(ours);

  console.log(`📋 ${ours.length} patch(es) in ${patchesDirectory()}/`);
  if (state === null) {
    console.log(`   No state file yet (${STATE_FILE}) — it is written by \`apply\`.`);
  }
  console.log('');

  let missing = 0;
  // Пропущенные дев-патчи не считаются ни лежащими, ни пропавшими: их пакета на
  // этой установке нет по замыслу, и в «столько-то из стольких» им места нет.
  let skipped = 0;

  for (const patchFile of ours) {
    const presence = shownPresence(patchFile, wholeSequenceApplied);
    const record = describeRecord(recorded.get(patchFile), patchFile);
    const why = headerLine(patchFile);
    const say = (line: string) => {
      console.log(line);
      if (why !== null) console.log(`     ${why}`);
    };

    if (presence.kind === 'in-tree') {
      say(`  ✅ ${patchFile} — in the tree, ${record}`);
      continue;
    }

    if (presence.kind === 'dev-only') {
      skipped++;
      say(`  ⏭  ${patchFile} — dev-only, and ${presence.missing} is not installed`);
      continue;
    }

    missing++;
    if (presence.kind === 'not-in-tree') {
      say(`  ⬜ ${patchFile} — not in the tree, ${record}`);
    } else {
      console.log(`  ❌ ${patchFile} — does not fit the tree, ${record}`);
      console.log(`     ${presence.reason}`);
      if (why !== null) console.log(`     ${why}`);
    }
  }

  const bunOwned = patchFiles.filter(file => byBun.has(file));
  if (bunOwned.length > 0) {
    console.log('');
    console.log(`🥟 ${bunOwned.length} patch(es) applied by bun itself (patchedDependencies):`);
    for (const file of bunOwned) console.log(`   ${file}`);
  }

  // Записи о патчах, которых в patches/ больше нет: сам файл удалили, а
  // изменения, скорее всего, так и лежат в node_modules.
  const orphans = [...recorded.keys()].filter(file => !ours.includes(file));
  if (orphans.length > 0) {
    console.log('');
    console.log(`⚠️  ${orphans.length} recorded patch file(s) no longer exist in ${patchesDirectory()}/:`);
    for (const file of orphans) console.log(`   ${file}`);
    console.log(`   Their changes may still be in node_modules. Reinstall it to be sure.`);
  }

  const counted = ours.length - skipped;
  if (counted > 0) {
    console.log('');
    console.log(`📊 ${counted - missing} of ${counted} in the tree`);
  }

  if (missing > 0 || orphans.length > 0) {
    process.exit(1);
  }
}

import {existsSync, readFileSync} from 'fs';
import {join} from 'path';
import {missingPackages, skipsMissingPackage} from './dev';
import {firstPathOutsideNodeModules, patchesAppliedByBun} from './foreign';
import {listPatchFiles, patchHeaderSummary, splitPatchHeader} from './patch-file';
import {patchesDirectory} from './paths';
import {Presence, outsideProjectReason, packagesOutsideProject, presenceOf, targetsOf} from './presence';
import {appliedSequences} from './sequence';
import {RecordedPatch, STATE_FILE, hashPatchBody, hashPatchFile, readState, recordedPatches} from './state';

// Что с патчем прямо сейчас. Определяется по дереву, а не по записи: запись
// говорит, что было, а спрашивают — что есть. Сам расчёт — общий с apply.
type Shown = Presence | {kind: 'unreadable'; reason: string} | {kind: 'dev-only'; missing: string};

// Файл патча читается один раз на патч, и из этого чтения отвечают все трое:
// разбор секций, строка заголовка и оба хеша. Пока каждый читал сам, `status`
// открывал один и тот же файл четырежды.
type PatchFile = {raw: Buffer; content: string} | {error: string};

function readPatchFile(patchFile: string): PatchFile {
  try {
    const raw = readFileSync(join(patchesDirectory(), patchFile));
    return {raw, content: raw.toString('utf-8')};
  } catch (error: any) {
    return {error: `cannot read patch file: ${error.message}`};
  }
}

function shownPresence(patchFile: string, file: PatchFile, wholeSequenceApplied: Set<string>): Shown {
  if (wholeSequenceApplied.has(patchFile)) return {kind: 'in-tree'};

  if ('error' in file) return {kind: 'unreadable', reason: file.error};

  const targets = targetsOf(file.content);
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

function describeRecord(record: RecordedPatch | undefined, file: PatchFile): string {
  if (record === undefined) return 'not in the state file';

  if (!('error' in file) && hashPatchFile(file.raw) !== record.sha256) {
    // Заголовок дерева не касается. Сказать про него «патч переписали» значило
    // бы звать человека разбираться туда, где менялось одно объяснение.
    if (record.bodySha256 !== undefined && record.bodySha256 === hashPatchBody(file.content)) {
      return `only its header changed since it was applied on ${record.appliedAt}`;
    }
    return `the patch file changed since it was applied on ${record.appliedAt}`;
  }
  return `applied ${record.appliedAt}`;
}

// Зачем этот патч существует — если в файле написано. Без этого имя файла
// говорит только про пакет и версию, и `status` отвечает на «что в дереве», но
// не на «что это вообще такое».
function headerLine(file: PatchFile): string | null {
  if ('error' in file) return null; // нечитаемый файл — забота presenceOf, а не этой строки
  return patchHeaderSummary(splitPatchHeader(file.content).header);
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
    const file = readPatchFile(patchFile);
    const presence = shownPresence(patchFile, file, wholeSequenceApplied);
    const record = describeRecord(recorded.get(patchFile), file);
    const why = headerLine(file);
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
  const known = new Set(ours);
  const orphans = [...recorded.keys()].filter(file => !known.has(file));
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

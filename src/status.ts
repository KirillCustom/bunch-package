import {existsSync, readFileSync, readdirSync} from 'fs';
import {join} from 'path';
import {orderPatchFiles, parsePatch} from './patch-file';
import {PATCHES_DIR} from './paths';
import {planTarget} from './plan';
import {appliedSequences} from './sequence';
import {RecordedPatch, STATE_FILE, hashPatchFile, readState} from './state';

// Что с патчем прямо сейчас. Определяется по дереву, а не по записи: запись
// говорит, что было, а спрашивают — что есть.
type Presence =
  | {kind: 'in-tree'}
  | {kind: 'not-in-tree'}
  | {kind: 'does-not-fit'; reason: string}
  | {kind: 'unreadable'; reason: string};

function presenceOf(patchFile: string, wholeSequenceApplied: Set<string>): Presence {
  if (wholeSequenceApplied.has(patchFile)) return {kind: 'in-tree'};

  let targets;
  try {
    targets = parsePatch(readFileSync(join(PATCHES_DIR, patchFile), 'utf-8'));
  } catch (error: any) {
    return {kind: 'unreadable', reason: error.message};
  }

  if (targets.length === 0) {
    return {kind: 'unreadable', reason: 'no hunks found — the patch file is empty or truncated'};
  }

  // Тот же расчёт, что делает apply: пустой план означает, что менять нечего,
  // то есть изменения патча уже в дереве.
  try {
    const ops = targets.flatMap(target => planTarget(target));
    return ops.length === 0 ? {kind: 'in-tree'} : {kind: 'not-in-tree'};
  } catch (error: any) {
    return {kind: 'does-not-fit', reason: error.message};
  }
}

function describeRecord(record: RecordedPatch | undefined, patchFile: string): string {
  if (record === undefined) return 'not in the state file';

  const path = join(PATCHES_DIR, patchFile);
  if (existsSync(path) && hashPatchFile(path) !== record.sha256) {
    return `the patch file changed since it was applied on ${record.appliedAt}`;
  }
  return `applied ${record.appliedAt}`;
}

export function showStatus(): void {
  const patchFiles = existsSync(PATCHES_DIR)
    ? orderPatchFiles(readdirSync(PATCHES_DIR).filter((file: string) => file.endsWith('.patch')))
    : [];

  // Запись читается до всякого выхода: патчей может не остаться вовсе, а их
  // изменения — лежать в node_modules. Промолчать об этом было бы худшим
  // ответом на вопрос «что сейчас в дереве».
  const state = readState();
  const recorded = new Map((state?.patches ?? []).map(patch => [patch.file, patch]));

  if (patchFiles.length === 0 && recorded.size === 0) {
    console.log(existsSync(PATCHES_DIR) ? '📭 No patches found' : '📭 No patches directory found');
    return;
  }

  const wholeSequenceApplied = appliedSequences(patchFiles);

  console.log(`📋 ${patchFiles.length} patch(es) in ${PATCHES_DIR}/`);
  if (state === null) {
    console.log(`   No state file yet (${STATE_FILE}) — it is written by \`apply\`.`);
  }
  console.log('');

  let missing = 0;

  for (const patchFile of patchFiles) {
    const presence = presenceOf(patchFile, wholeSequenceApplied);
    const record = describeRecord(recorded.get(patchFile), patchFile);

    if (presence.kind === 'in-tree') {
      console.log(`  ✅ ${patchFile} — in the tree, ${record}`);
      continue;
    }

    missing++;
    if (presence.kind === 'not-in-tree') {
      console.log(`  ⬜ ${patchFile} — not in the tree, ${record}`);
    } else {
      console.log(`  ❌ ${patchFile} — does not fit the tree, ${record}`);
      console.log(`     ${presence.reason}`);
    }
  }

  // Записи о патчах, которых в patches/ больше нет: сам файл удалили, а
  // изменения, скорее всего, так и лежат в node_modules.
  const orphans = [...recorded.keys()].filter(file => !patchFiles.includes(file));
  if (orphans.length > 0) {
    console.log('');
    console.log(`⚠️  ${orphans.length} recorded patch file(s) no longer exist in ${PATCHES_DIR}/:`);
    for (const file of orphans) console.log(`   ${file}`);
    console.log(`   Their changes may still be in node_modules. Reinstall it to be sure.`);
  }

  if (patchFiles.length > 0) {
    console.log('');
    console.log(`📊 ${patchFiles.length - missing} of ${patchFiles.length} in the tree`);
  }

  if (missing > 0 || orphans.length > 0) {
    process.exit(1);
  }
}

import {existsSync} from 'fs';
import {join} from 'path';
import {listPatchFiles} from './patch-file';
import {PATCHES_DIR} from './paths';
import {Presence, presenceOf, readTargets} from './presence';
import {appliedSequences} from './sequence';
import {RecordedPatch, STATE_FILE, hashPatchFile, readState, recordedPatches} from './state';

// Что с патчем прямо сейчас. Определяется по дереву, а не по записи: запись
// говорит, что было, а спрашивают — что есть. Сам расчёт — общий с apply.
type Shown = Presence | {kind: 'unreadable'; reason: string};

function shownPresence(patchFile: string, wholeSequenceApplied: Set<string>): Shown {
  if (wholeSequenceApplied.has(patchFile)) return {kind: 'in-tree'};

  const targets = readTargets(patchFile);
  if ('error' in targets) return {kind: 'unreadable', reason: targets.error};

  return presenceOf(targets);
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
  const patchFiles = listPatchFiles();

  // Запись читается до всякого выхода: патчей может не остаться вовсе, а их
  // изменения — лежать в node_modules. Промолчать об этом было бы худшим
  // ответом на вопрос «что сейчас в дереве».
  const state = readState();
  const recorded = recordedPatches(state);

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
    const presence = shownPresence(patchFile, wholeSequenceApplied);
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

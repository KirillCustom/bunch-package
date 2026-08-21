import {cpSync, existsSync, readdirSync, rmSync, writeFileSync} from 'fs';
import {join} from 'path';
import {diffTrees, fetchPristine, readManifest, requireDiff, validatePackageName} from './create';
import {orderPatchFiles, parsePatchName} from './patch-file';
import {PATCHES_DIR, ensureDir} from './paths';
import {replayPatches} from './sequence';

// Пакет обновили — патчи остались от старой версии. `apply` о таком только
// предупреждает, дальше человек разбирается руками.
//
// Здесь патчи переписываются под установленную версию: их правки заново
// накладываются на свежий эталон и снимаются диффом обратно. Строки контекста и
// номера строк при этом берутся из новой версии, то есть патч перестаёт быть
// «примерно подходящим» и становится точным.
//
// Имя команды не `rebase`: у patch-package так называется другое — снять патчи,
// лежащие поверх указанного. Одинаковое имя для разных дел было бы ловушкой,
// потому что патчи ходят между инструментами.
export function retargetPatches(packageName: string): void {
  validatePackageName(packageName);
  requireDiff();

  const packagePath = join(process.cwd(), 'node_modules', packageName);
  if (!existsSync(packagePath)) {
    throw new Error(`Package ${packageName} not found in node_modules`);
  }

  const {name, version} = readManifest(packagePath);

  const mine = existsSync(PATCHES_DIR)
    ? orderPatchFiles(
        readdirSync(PATCHES_DIR).filter(
          file => file.endsWith('.patch') && parsePatchName(file)?.packageDir === name,
        ),
      )
    : [];

  if (mine.length === 0) {
    throw new Error(`No patches found for ${name} in ${PATCHES_DIR}/`);
  }

  const versions = new Set(mine.map(file => parsePatchName(file)!.version));
  if (versions.size > 1) {
    throw new Error(
      `Patches for ${name} carry more than one version (${[...versions].join(', ')}).\n` +
        `   Sort that out first: a sequence is built against one version.`,
    );
  }

  const from = [...versions][0];
  if (from === version) {
    console.log(`✅ Patches for ${name} already target ${version} — nothing to do`);
    return;
  }

  console.log(`📦 Moving ${mine.length} patch(es) for ${name} from ${from} to ${version}...`);

  const tempDir = join(process.cwd(), '.bunch-patch-tmp');

  try {
    rmSync(tempDir, {force: true, recursive: true});
    ensureDir(tempDir);

    console.log(`📥 Fetching pristine ${name}@${version}...`);
    const pristine = fetchPristine(name, version, tempDir);
    if (!existsSync(pristine)) {
      throw new Error(`Pristine copy of ${name}@${version} did not land at ${pristine}`);
    }

    const moved = replayOnto(mine, packageName, name, version, pristine, tempDir);
    writeMoved(mine, moved, version);
  } finally {
    rmSync(tempDir, {force: true, recursive: true});
  }
}

interface MovedPatch {
  from: string; // старое имя файла
  to: string; // новое имя файла
  content: string; // пустое означает, что переносить нечего
}

// Каждый патч накладывается на снимок предыдущего состояния, и разница между
// соседними снимками — это он же, но записанный против новой версии.
function replayOnto(
  files: string[],
  packageName: string,
  name: string,
  version: string,
  pristine: string,
  tempDir: string,
): MovedPatch[] {
  const moved: MovedPatch[] = [];
  let previous = join(tempDir, 'state-0');
  cpSync(pristine, previous, {recursive: true, verbatimSymlinks: true});

  for (const [index, file] of files.entries()) {
    const current = join(tempDir, `state-${index + 1}`);
    cpSync(previous, current, {recursive: true, verbatimSymlinks: true});

    // Не лёг — значит вокруг этого места пакет изменился, и подгонять контекст
    // мы не будем: [[DEC-4]]. Пусть человек посмотрит сам, зная точное место.
    try {
      replayPatches([file], packageName, current);
    } catch (error: any) {
      throw new Error(
        `${file} does not fit ${name}@${version}:\n   ${error.message}\n` +
          `   Nothing was changed. Apply what you can by hand in node_modules/${packageName}\n` +
          `   and rebuild the patch with \`bunch-package create ${packageName}\`.`,
      );
    }

    const diff = diffTrees(previous, current, packageName, name, version);
    const parsed = parsePatchName(file)!;
    const suffix = parsed.sequence > 0
      ? `+${String(parsed.sequence).padStart(3, '0')}+${parsed.label}`
      : '';

    moved.push({
      from: file,
      to: `${name.replace(/\//g, '+')}+${version}${suffix}.patch`,
      content: diff.content,
    });

    previous = current;
  }

  return moved;
}

function writeMoved(old: string[], moved: MovedPatch[], version: string): void {
  const carried = moved.filter(patch => patch.content !== '');
  const empty = moved.filter(patch => patch.content === '');

  for (const patch of empty) {
    // Патч, от которого на новой версии не осталось разницы: его правку уже
    // внесли выше по течению. Молча уронить такой файл нельзя — это и есть
    // новость, ради которой команду запускали.
    console.log(`⏭  ${patch.from} — its change is already in ${version}, dropping it`);
  }

  // Старые файлы убираем только после того, как всё сошлось: полпереноса —
  // состояние, из которого не выбраться.
  for (const file of old) rmSync(join(PATCHES_DIR, file), {force: true});

  for (const patch of carried) {
    writeFileSync(join(PATCHES_DIR, patch.to), patch.content);
    console.log(`  ✅ ${patch.from} → ${patch.to}`);
  }

  if (carried.length === 0) {
    console.log(`\n📊 Nothing left to patch in ${version} — all changes are already there.`);
    return;
  }

  console.log(`\n📊 ${carried.length} patch(es) now target ${version}`);
  console.log(`   Run \`bunch-package apply\` to put them into node_modules.`);
}

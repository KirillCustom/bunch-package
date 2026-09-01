import {cpSync, existsSync, readFileSync, renameSync, rmSync, writeFileSync} from 'fs';
import {join} from 'path';
import {diffTrees, readManifest, requireDiff, validatePackageName, withPristine} from './create';
import {formatPatchName, listPatchFiles, parsePatchName, splitPatchHeader, updatePatchHeader} from './patch-file';
import {patchesDirectory} from './paths';
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

  // Патчи вложенной зависимости названы путём под node_modules — см. create().
  const patchDir = packageName.includes('/node_modules/') ? packageName : name;
  const mine = listPatchFiles().filter(file => parsePatchName(file)?.packageDir === patchDir);

  if (mine.length === 0) {
    throw new Error(`No patches found for ${name} in ${patchesDirectory()}/`);
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

  withPristine(name, version, (pristine, tempDir) => {
    writeMoved(replayOnto(mine, packageName, name, version, pristine, tempDir), version);
  });
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

  // Эталон переезжает в первый снимок, а не копируется: под своим именем он
  // дальше никому не нужен, а копия дерева пакета стоит столько же, сколько
  // само дерево.
  let previous = join(tempDir, 'state-0');
  renameSync(pristine, previous);

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

    // Заголовок переезжает вместе с патчем: от смены версии пакета причина, по
    // которой патч существует, не меняется. У патча, от которого на новой
    // версии ничего не осталось, содержимое обязано остаться пустым — иначе
    // один заголовок и был бы «перенесённым патчем».
    const header = splitPatchHeader(readFileSync(join(patchesDirectory(), file), 'utf-8')).header;

    moved.push({
      from: file,
      to: formatPatchName({...parsePatchName(file)!, version}),
      content: diff.content === '' ? '' : updatePatchHeader(header, {}) + diff.content,
    });

    // Снимок отработал своё: он был левой стороной диффа, и больше его никто не
    // откроет. Без этого к концу последовательности во временном каталоге лежит
    // по копии дерева пакета на каждый патч.
    rmSync(previous, {force: true, recursive: true});
    previous = current;
  }

  return moved;
}

function writeMoved(moved: MovedPatch[], version: string): void {
  const carried = moved.filter(patch => patch.content !== '');

  for (const patch of moved) {
    // Патч, от которого на новой версии не осталось разницы: его правку уже
    // внесли выше по течению. Молча уронить такой файл нельзя — это и есть
    // новость, ради которой команду запускали.
    if (patch.content === '') {
      console.log(`⏭  ${patch.from} — its change is already in ${version}, dropping it`);
    }
  }

  // Старые файлы убираем только после того, как всё сошлось: полпереноса —
  // состояние, из которого не выбраться.
  for (const patch of moved) rmSync(join(patchesDirectory(), patch.from), {force: true});

  for (const patch of carried) {
    writeFileSync(join(patchesDirectory(), patch.to), patch.content);
    console.log(`  ✅ ${patch.from} → ${patch.to}`);
  }

  if (carried.length === 0) {
    console.log(`\n📊 Nothing left to patch in ${version} — all changes are already there.`);
    return;
  }

  console.log(`\n📊 ${carried.length} patch(es) now target ${version}`);
  console.log(`   Run \`bunch-package apply\` to put them into node_modules.`);
}

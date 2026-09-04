import {existsSync, readFileSync, realpathSync, rmSync, writeFileSync} from 'fs';
import {join} from 'path';
import {
  diffTrees,
  readManifest,
  requireDiff,
  validatePackageName,
  withPristine,
} from './create';
import {bunAlsoPatches} from './foreign';
import {
  formatPatchName,
  listPatchFiles,
  parsePatchName,
  patchHeaderField,
  splitPatchHeader,
  updatePatchHeader,
  patchNameKey,
} from './patch-file';
import {installedPackagePath, packageNotFoundError, patchesDirectory, realPathOutsideProject} from './paths';
import {isInTree} from './presence';
import {recordPatches, recordedPatches} from './state';

// Заголовки схлопываемых патчей не выбрасываются: «зачем этот патч существует» —
// единственное, чего больше нигде нет, и потерять его при схлопывании значит
// уничтожить ровно то знание, ради которого заголовок заводили. Причины
// собираются в одну строку по порядку патчей, ссылка берётся первая непустая,
// а всё, что человек написал руками, переезжает как есть.
function mergeHeaders(headers: string[]): string {
  const reasons: string[] = [];
  const handwritten: string[] = [];
  let upstream: string | undefined;

  for (const header of headers) {
    const why = patchHeaderField(header, 'Why');
    if (why !== null && why !== '' && !reasons.includes(why)) reasons.push(why);

    const link = patchHeaderField(header, 'Upstream');
    if (upstream === undefined && link !== null && link !== '') upstream = link;

    for (const line of header.split('\n')) {
      if (line.trim() === '' || /^(Why|Upstream):/i.test(line)) continue;
      if (!handwritten.includes(line)) handwritten.push(line);
    }
  }

  const base = handwritten.length === 0 ? '' : handwritten.join('\n') + '\n\n';
  return updatePatchHeader(base, {
    why: reasons.length === 0 ? undefined : reasons.join('; '),
    upstream,
  });
}

export function foldPatches(packageName: string): void {
  validatePackageName(packageName);
  requireDiff();

  const packagePath = installedPackagePath(packageName);
  if (!existsSync(packagePath)) {
    throw packageNotFoundError(packageName);
  }

  const {name, version} = readManifest(packagePath);

  if (bunAlsoPatches(name)) {
    throw new Error(`${name} is patched by bun through patchedDependencies — its patches are not ours to fold.`);
  }

  const shared = realPathOutsideProject(`node_modules/${packageName}`);
  if (shared !== null) {
    throw new Error(
      `node_modules/${packageName} resolves to ${shared}, outside the project — that is bun's shared store.\n` +
        `   Folding reads the tree there, and the result would describe a package every project on this machine shares.\n` +
        `   Reinstall with the store inside the project: BUN_INSTALL_GLOBAL_STORE=0 bun install`,
    );
  }

  // Имя патча говорит, куда он ложится: это каталог в node_modules. Файлы,
  // созданные до 1.17.0, названы по манифесту — их имя тоже понимаем.
  const patchDir = patchNameKey(packageName, name);

  const sequenced = listPatchFiles().filter(file => {
    const parsed = parsePatchName(file);
    return parsed !== null && parsed.packageDir === patchDir && parsed.version === version && parsed.sequence > 0;
  });

  if (sequenced.length < 2) {
    throw new Error(
      sequenced.length === 0
        ? `No patch sequence for ${patchDir}@${version} — nothing to fold.`
        : `${patchDir}@${version} has a single patch (${sequenced[0]}) — nothing to fold.`,
    );
  }

  // Схлопывание берёт дерево как есть и объявляет его итогом последовательности.
  // Не хватает хотя бы одного патча — итог был бы другим: правка отсутствующего
  // патча молча выпала бы из нового файла, а старые файлы уже удалены.
  const missing = sequenced.filter(file => !isInTree(file));
  if (missing.length > 0) {
    throw new Error(
      `These patches are not in node_modules right now:\n` +
        missing.map(file => `     ${file}`).join('\n') +
        `\n   Folding would drop their changes. Run \`bunch-package apply\` first.`,
    );
  }

  const devOnly = sequenced.some(file => parsePatchName(file)?.devOnly === true);
  const outputName = formatPatchName({packageDir: patchDir, version, devOnly});
  const header = mergeHeaders(
    sequenced.map(file => splitPatchHeader(readFileSync(join(patchesDirectory(), file), 'utf-8')).header),
  );

  console.log(`🗜  Folding ${sequenced.length} patches for ${patchDir}@${version}...`);

  // Символическая ссылка в node_modules — путь для diff берём разыменованным:
  // GNU diff, получив ссылку на каталог, ищет файл с таким именем в эталоне.
  const realPackagePath = realpathSync(packagePath);

  withPristine(name, version, cleanPackagePath => {
    // Эталон не доводится ничем: дерево уже содержит всю последовательность,
    // значит разница между чистым пакетом и деревом — это и есть её итог.
    const diff = diffTrees(cleanPackagePath, realPackagePath, packageName, name, version);

    if (diff.content === '') {
      throw new Error(
        `The tree matches the pristine ${name}@${version} — the sequence adds up to no change at all.\n` +
          `   Nothing was written, and the ${sequenced.length} patch files are untouched.`,
      );
    }

    // Что исчезнет — говорим до того, как оно исчезнет: схлопывание необратимо,
    // и вернуть эти файлы может только git, если они были закоммичены.
    console.log(`   These files will be replaced by ${outputName}:`);
    for (const file of sequenced) console.log(`     ${file}`);

    // Пишем новый до удаления старых: половина схлопывания — состояние, в
    // котором нет ни последовательности, ни её замены.
    writeFileSync(join(patchesDirectory(), outputName), header + diff.content);
    for (const file of sequenced) rmSync(join(patchesDirectory(), file), {force: true});

    // Запись о применённом идёт следом: дерево не менялось, а имена патчей в
    // нём — да, и `status` иначе назвал бы схлопнутые файлы пропавшими.
    // Имя схлопнутого патча — это имя одиночного, и оно уже могло стоять в
    // записи: последовательность начинается с одиночного патча, который
    // `create --append` переименовывает в `001+…`. Без второго условия запись
    // получала два элемента с одним именем.
    const kept = [...recordedPatches().keys()].filter(
      file => !sequenced.includes(file) && file !== outputName,
    );
    // Схлопнутые файлы удалены нами, и их изменения не потеряны — они внутри
    // outputName. Иначе записи о них остались бы как об исчезнувших, и `status`
    // предупреждал бы о правках, которые честно описаны новым патчем.
    recordPatches([...kept, outputName], {forget: sequenced});

    console.log(`\n✅ ${outputName}`);
    console.log(`   ${sequenced.length} patches folded into one; node_modules is unchanged.`);
  });
}

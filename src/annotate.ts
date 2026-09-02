import {execFileSync} from 'child_process';
import {existsSync, readFileSync, writeFileSync} from 'fs';
import {join} from 'path';
import {readManifest, requireDiff, validatePackageName, withPristine} from './create';
import {bunAlsoPatches} from './foreign';
import {listPatchFiles, orderPatchFiles, parsePatch, parsePatchName} from './patch-file';
import {installedPackagePath, realPathOutsideProject} from './paths';
import {replayPatches} from './sequence';

// Метка строки — индекс патча, который её принёс, или null: строку никто не
// добавлял, она приехала с пакетом из реестра.

// Метки переносятся с версии на версию через обычный unified diff между
// соседними состояниями файла: строки, которых в старой версии не было,
// принадлежат патчу, а всё остальное наследует прежнюю метку.
//
// Свой алгоритм сравнения строк писать незачем: `diff` проекту уже нужен для
// `create`, а его вывод мы и так умеем разбирать — тем же parsePatch, что
// читает патчи.
function carryLabels(
  oldPath: string,
  newPath: string,
  oldLabels: (number | null)[],
  patchIndex: number,
  newLineCount: number,
): (number | null)[] {
  let unified: string;
  try {
    // Код выхода 1 у diff означает «есть различия», а не сбой.
    unified = execFileSync('diff', ['-u', oldPath, newPath], {encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024});
    return [...oldLabels]; // различий нет — патч этого файла не касался
  } catch (error: any) {
    if (error.status !== 1 || typeof error.stdout !== 'string') {
      throw new Error(`diff failed while tracing lines: ${error.stderr || error.message}`);
    }
    unified = error.stdout;
  }

  const labels: (number | null)[] = [];
  let oldAt = 0; // сколько строк старой версии уже разобрано

  for (const hunk of parsePatch(unified)[0]?.hunks ?? []) {
    // Всё, что до хунка, в обеих версиях совпадает построчно.
    while (oldAt < hunk.oldStart - 1) {
      labels.push(oldLabels[oldAt]);
      oldAt++;
    }

    for (const line of hunk.lines) {
      const kind = line[0];
      if (kind === '+') {
        labels.push(patchIndex);
        continue;
      }
      // Контекст переносит прежнюю метку, удаление просто съедает строку.
      if (kind === ' ') labels.push(oldLabels[oldAt]);
      oldAt++;
    }
  }

  while (oldAt < oldLabels.length) {
    labels.push(oldLabels[oldAt]);
    oldAt++;
  }

  // Хвост на всякий случай: если diff и наш счёт разошлись, лучше показать
  // строку без метки, чем оборвать вывод.
  while (labels.length < newLineCount) labels.push(null);
  return labels.slice(0, newLineCount);
}

function linesOf(path: string): string[] {
  const content = readFileSync(path, 'utf-8');
  const lines = content.split('\n');
  // Последний перевод строки не создаёт строки.
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

export function annotateFile(packageName: string, relativePath: string): void {
  validatePackageName(packageName);
  requireDiff();

  const packagePath = installedPackagePath(packageName);
  if (!existsSync(packagePath)) {
    throw new Error(`Package ${packageName} not found in node_modules`);
  }

  const shared = realPathOutsideProject(`node_modules/${packageName}`);
  if (shared !== null) {
    throw new Error(
      `node_modules/${packageName} resolves to ${shared}, outside the project — that is bun's shared store.\n` +
        `   What it holds is not this project's tree, so annotating it would describe someone else's.`,
    );
  }

  const {name, version} = readManifest(packagePath);
  if (bunAlsoPatches(name)) {
    throw new Error(`${name} is patched by bun through patchedDependencies — those patches are not ours to trace.`);
  }

  const inTree = join(packagePath, relativePath);
  if (!existsSync(inTree)) {
    throw new Error(`node_modules/${packageName}/${relativePath} does not exist`);
  }

  const patchDir = packageName.includes('/node_modules/') ? packageName : name;
  const patches = orderPatchFiles(
    listPatchFiles().filter(file => {
      const parsed = parsePatchName(file);
      return parsed !== null && parsed.packageDir === patchDir && parsed.version === version;
    }),
  );

  if (patches.length === 0) {
    throw new Error(`No patches for ${patchDir}@${version} — every line of that file came with the package.`);
  }

  console.log(`📖 node_modules/${packageName}/${relativePath}`);
  console.log('');
  for (const [index, file] of patches.entries()) {
    console.log(`  ${String(index + 1).padStart(3, '0')}  ${file}`);
  }
  console.log('');

  withPristine(name, version, (cleanPackagePath, tempDir) => {
    const traced = join(cleanPackagePath, relativePath);

    // Файла может не быть в чистом пакете — тогда его целиком создал патч.
    let previous = join(tempDir, 'annotate-previous');
    let labels: (number | null)[] = [];
    if (existsSync(traced)) {
      writeFileSync(previous, readFileSync(traced));
      labels = linesOf(traced).map(() => null);
    } else {
      writeFileSync(previous, '');
    }

    for (const [index, file] of patches.entries()) {
      replayPatches([file], packageName, cleanPackagePath);

      const current = join(tempDir, `annotate-step-${index}`);
      writeFileSync(current, existsSync(traced) ? readFileSync(traced) : Buffer.alloc(0));

      labels = carryLabels(previous, current, labels, index + 1, existsSync(traced) ? linesOf(traced).length : 0);
      previous = current;
    }

    // Аннотация описывает то, что дают патчи. Если файл в дереве не такой —
    // его правили помимо них, и приписывать эти строки патчам было бы враньём.
    const expected = existsSync(traced) ? readFileSync(traced, 'utf-8') : '';
    if (readFileSync(inTree, 'utf-8') !== expected) {
      throw new Error(
        `node_modules/${packageName}/${relativePath} is not what the patches produce.\n` +
          `   Either a patch is missing from the tree (run \`bunch-package apply\`), or the file was edited by hand.\n` +
          `   Nothing is annotated, because the lines could not be attributed honestly.`,
      );
    }

    const lines = linesOf(traced);
    const width = String(lines.length).length;

    for (const [at, text] of lines.entries()) {
      const from = labels[at];
      const mark = from === null || from === undefined ? '   ' : String(from).padStart(3, '0');
      console.log(`  ${String(at + 1).padStart(width)}  ${mark}  ${text}`);
    }

    const touched = new Set(labels.filter((label): label is number => label !== null && label !== undefined));
    console.log('');
    console.log(
      touched.size === 0
        ? `📊 No line of this file comes from a patch.`
        : `📊 ${labels.filter(label => label !== null).length} line(s) from ${touched.size} patch(es).`,
    );
  });
}

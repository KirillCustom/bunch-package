import {existsSync, readFileSync, readdirSync} from 'fs';
import {join} from 'path';
import {formatPatchName, orderPatchFiles, parsePatch, parsePatchName} from './patch-file';
import {patchesDirectory} from './paths';
import {isInTree} from './presence';
import {PlannedOp, TreeContext, executeOps, planTarget} from './plan';
import {recordedPatches} from './state';

export interface SequencePlan {
  replay: string[]; // патчи, которыми надо довести эталон
  outputName: string;
  renameFrom: string | null;
  renameTo: string | null;
}

// Какой патч последовательности пересоздаём. Обычно — последний по номеру, но
// после `rebase` верхние сняты, и переписать надо тот, на который откатились.
//
// Одним лишь деревом это не решается: к моменту `create` пользователь уже
// поменял файлы, и целевой патч перестал совпадать с деревом — по нему видно
// только, что он «не лежит». Поэтому подсказку берём из записи о применённом, а
// дерево используем как проверку: патчи **после** подсказанного обязаны быть не
// в дереве, иначе их правки уехали бы в пересоздаваемый патч.
function targetOfSequence(sequenced: string[]): number {
  const recorded = recordedPatches();

  const hinted = sequenced.findLastIndex(file => recorded.has(file));
  if (hinted !== -1 && !sequenced.slice(hinted + 1).some(isInTree)) return hinted;

  // Запись отстала от дерева — верим дереву.
  return sequenced.findLastIndex(isInTree);
}

export function planSequence(packageDir: string, version: string, appendLabel: string | null): SequencePlan {
  const named = (sequence?: number, label?: string) =>
    formatPatchName({packageDir, version, sequence, label});
  const prefix = `${packageDir.replace(/\//g, '+')}+${version}`;
  const siblings = existsSync(patchesDirectory())
    ? orderPatchFiles(
        readdirSync(patchesDirectory()).filter(
          (f: string) => f.endsWith('.patch') && (f === `${prefix}.patch` || f.startsWith(`${prefix}+`)),
        ),
      )
    : [];

  const sequenceOf = (file: string): number => parsePatchName(file)?.sequence ?? 0;

  if (appendLabel !== null) {
    // Одиночный патч задним числом становится первым в последовательности:
    // без номера он потерялся бы среди следующих.
    if (siblings.length === 1 && sequenceOf(siblings[0]) === 0) {
      return {
        replay: siblings,
        outputName: named(2, appendLabel),
        renameFrom: siblings[0],
        renameTo: named(1, 'initial'),
      };
    }

    const next = siblings.length > 0 ? sequenceOf(siblings[siblings.length - 1]) + 1 : 1;
    return {
      replay: siblings,
      outputName: named(next, appendLabel),
      renameFrom: null,
      renameTo: null,
    };
  }

  // Без --append обновляем последний патч, который **сейчас в дереве**, а не
  // последний по номеру. Обычно это одно и то же, но после `rebase` верхние
  // патчи сняты, и переписывать надо тот, на который откатились.
  const sequenced = siblings.filter(file => sequenceOf(file) > 0);
  if (sequenced.length > 0) {
    const target = targetOfSequence(sequenced);

    // Ни одного патча последовательности в дереве нет. Раньше здесь молча
    // переписывался последний: эталон доводился всеми предыдущими патчами, а
    // дерево их не содержало — и в новый патч уезжала отмена чужих правок.
    if (target === -1) {
      throw new Error(
        `None of the ${sequenced.length} patches for this package is in node_modules right now.\n` +
          `   Run \`bunch-package apply\` first, or use --append to start a new patch.`,
      );
    }

    return {
      replay: sequenced.slice(0, target),
      outputName: sequenced[target],
      renameFrom: null,
      renameTo: null,
    };
  }

  return {replay: [], outputName: named(), renameFrom: null, renameTo: null};
}

// Доводим эталон до состояния «после уже существующих патчей».
export function replayPatches(files: string[], packageDir: string, root: string): void {
  const context: TreeContext = {root, prefix: `node_modules/${packageDir}/`};
  for (const file of files) {
    const targets = parsePatch(readFileSync(join(patchesDirectory(), file), 'utf-8'));
    const ops: PlannedOp[] = [];
    for (const target of targets) {
      try {
        ops.push(...planTarget(target, context));
      } catch (error: any) {
        throw new Error(`${file} does not fit the pristine copy: ${error.message}`);
      }
    }
    executeOps(ops);
  }
}

// Патч из середины последовательности нельзя проверить в одиночку: его «после»
// перестаёт существовать, как только сверху лёг следующий, и обратное применение
// перестаёт его узнавать. Поэтому применённость последовательности определяем по
// последнему патчу — его состояние и есть итоговое.
//
// Частично применённая последовательность сюда не попадает и разбирается обычным
// путём: там каждый патч по отдельности либо ложится, либо уже узнаётся.
export function appliedSequences(files: string[]): Set<string> {
  const groups = new Map<string, string[]>();

  for (const file of files) {
    const parsed = parsePatchName(file);
    if (parsed === null || parsed.sequence === 0) continue;
    const key = `${parsed.packageDir}@${parsed.version}`;
    groups.set(key, [...(groups.get(key) ?? []), file]);
  }

  const applied = new Set<string>();

  for (const group of groups.values()) {
    if (group.length < 2) continue;
    // Последний не лёг и не узнаётся — значит последовательность не на месте
    // целиком, и каждый патч надо разбирать по отдельности.
    if (isInTree(group[group.length - 1])) for (const file of group) applied.add(file);
  }

  return applied;
}

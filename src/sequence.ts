import {existsSync, readFileSync, readdirSync} from 'fs';
import {join} from 'path';
import {orderPatchFiles, parsePatch, parsePatchName} from './patch-file';
import {PATCHES_DIR} from './paths';
import {PlannedOp, TreeContext, executeOps, planTarget} from './plan';

export interface SequencePlan {
  replay: string[]; // патчи, которыми надо довести эталон
  outputName: string;
  renameFrom: string | null;
  renameTo: string | null;
}

export function planSequence(sanitizedName: string, version: string, appendLabel: string | null): SequencePlan {
  const prefix = `${sanitizedName}+${version}`;
  const siblings = existsSync(PATCHES_DIR)
    ? orderPatchFiles(
        readdirSync(PATCHES_DIR).filter(
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
        outputName: `${prefix}+002+${appendLabel}.patch`,
        renameFrom: siblings[0],
        renameTo: `${prefix}+001+initial.patch`,
      };
    }

    const next = siblings.length > 0 ? sequenceOf(siblings[siblings.length - 1]) + 1 : 1;
    return {
      replay: siblings,
      outputName: `${prefix}+${String(next).padStart(3, '0')}+${appendLabel}.patch`,
      renameFrom: null,
      renameTo: null,
    };
  }

  // Без --append обновляем последний патч последовательности: эталон доводим
  // всеми предыдущими, а его самого пересоздаём.
  const sequenced = siblings.filter(file => sequenceOf(file) > 0);
  if (sequenced.length > 0) {
    return {
      replay: sequenced.slice(0, -1),
      outputName: sequenced[sequenced.length - 1],
      renameFrom: null,
      renameTo: null,
    };
  }

  return {replay: [], outputName: `${prefix}.patch`, renameFrom: null, renameTo: null};
}

// Доводим эталон до состояния «после уже существующих патчей».
export function replayPatches(files: string[], packageDir: string, root: string): void {
  const context: TreeContext = {root, prefix: `node_modules/${packageDir}/`};
  for (const file of files) {
    const targets = parsePatch(readFileSync(join(PATCHES_DIR, file), 'utf-8'));
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
    try {
      const targets = parsePatch(readFileSync(join(PATCHES_DIR, group[group.length - 1]), 'utf-8'));
      const ops = targets.flatMap(target => planTarget(target));
      if (ops.length === 0) for (const file of group) applied.add(file);
    } catch {
      // Последний не ложится и не узнаётся — значит последовательность не на
      // месте целиком, и каждый патч надо разбирать по отдельности.
    }
  }

  return applied;
}

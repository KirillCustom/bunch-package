import {readFileSync, realpathSync} from 'fs';
import {homedir} from 'os';
import {join, sep} from 'path';
import {PatchTarget, parsePatch} from './patch-file';
import {packageDirectoryOf, patchesDirectory, realPathOutsideProject, stripPathPrefix} from './paths';
import {PlannedOp, planTarget} from './plan';

// Один вопрос — «что сейчас с этим патчем относительно дерева» — и один ответ на
// него. Раньше он был посчитан пятью независимыми копиями (apply, status, обе
// проверки в sequence и откат), и каждая по-своему решала, что делать с
// исключением. Правило применённости за одну сессию менялось дважды; пока копий
// было пять, любая правка обязана была попасть во все, а расхождение выглядело
// бы не падением, а разными ответами команд про один и тот же патч.
export type Presence =
  | {kind: 'in-tree'}
  | {kind: 'not-in-tree'; ops: PlannedOp[]}
  | {kind: 'does-not-fit'; reason: string};

// Разбор отдельно от чтения: `status` спрашивает у одного и того же файла и
// секции, и заголовок, и оба хеша, — а пока разбор читал файл сам, тот же файл
// открывался на патч четыре раза.
export function targetsOf(content: string): PatchTarget[] | {error: string} {
  const targets = parsePatch(content);
  if (targets.length === 0) {
    return {error: 'no hunks found — the patch file is empty or truncated'};
  }
  return targets;
}

export function readTargets(patchFile: string): PatchTarget[] | {error: string} {
  let content: string;
  try {
    content = readFileSync(join(patchesDirectory(), patchFile), 'utf-8');
  } catch (error: any) {
    return {error: `cannot read patch file: ${error.message}`};
  }

  return targetsOf(content);
}

// Каталог пакета, в который ложится патч, — по путям внутри него самого. Это
// единственный надёжный ответ: имя файла говорит лишь то, как патч назвали, а
// у алиасной установки каталог и имя пакета расходятся. Спрашивают трое: rebase
// и retarget — чтобы не сгрести в один набор патчи двух разных каталогов,
// create — чтобы понять, свой ли файл он собирается переписать.
export function patchTargetDirectory(patchFile: string): string | null {
  const targets = readTargets(patchFile);
  if ('error' in targets) return null;

  for (const target of targets) {
    const raw = target.newPath ?? target.oldPath;
    if (raw === null) continue;

    const directory = packageDirectoryOf(stripPathPrefix(raw));
    // packageDirectoryOf отвечает путём от корня проекта: `node_modules/mynum`,
    // а спрашивают про `mynum` — то самое, что стоит в имени файла патча.
    if (directory !== null) return directory.slice('node_modules/'.length);
  }

  return null;
}

// Пустой план означает, что менять нечего, то есть изменения патча уже в дереве.
// Операции возвращаются здесь же: apply всё равно собирается их исполнить, и
// считать план дважды незачем.
export function presenceOf(targets: PatchTarget[]): Presence {
  const ops: PlannedOp[] = [];

  for (const target of targets) {
    try {
      ops.push(...planTarget(target));
    } catch (error: any) {
      return {kind: 'does-not-fit', reason: error.message};
    }
  }

  return ops.length === 0 ? {kind: 'in-tree'} : {kind: 'not-in-tree', ops};
}

// То же самое, когда нужен только ответ «да или нет»: первая же секция, которую
// пришлось бы менять, закрывает вопрос. Планировать остальные — это чтение
// каждого файла патча впустую, а зовётся это на каждый `bun install`.
export function isInTree(patchFile: string): boolean {
  const targets = readTargets(patchFile);
  if ('error' in targets) return false;

  try {
    return !targets.some(target => planTarget(target).length > 0);
  } catch {
    return false; // не ложится и не узнаётся — значит его в дереве нет
  }
}

// Пакеты патча, которые лежат не там, где написано. Спрашивают все, кто пишет в
// дерево: apply, rebase и reverse, — и status, чтобы не отвечать «в дереве» про
// дерево, которое проекту не принадлежит.
export interface OutsidePackage {
  directory: string; // как записано в патче: node_modules/<pkg>
  real: string; // куда ведёт на диске
}

export function packagesOutsideProject(targets: PatchTarget[]): OutsidePackage[] {
  const found: OutsidePackage[] = [];

  for (const target of targets) {
    const raw = target.newPath ?? target.oldPath;
    if (raw === null) continue;

    const directory = packageDirectoryOf(stripPathPrefix(raw));
    if (directory === null || found.some(other => other.directory === directory)) continue;

    const real = realPathOutsideProject(directory);
    if (real !== null) found.push({directory, real});
  }

  return found;
}

// Один и тот же текст у apply, rebase и status: расходиться в объяснении одного
// и того же отказа — значит трижды объяснять его по-разному.
//
// Причина отказа одна: мы не пишем за пределы проекта. Но объяснение зависит
// от того, куда ведёт путь. Когда он ведёт в кеш bun — человек пойдёт
// переустанавливать пакет правильным способом; когда node_modules просто
// вынесен наружу — совет про BUN_INSTALL_GLOBAL_STORE не по делу и только
// запутает. Жалоба patch-package #377; воспроизведено 04.09.2026.
function bunInstallCacheDir(): string {
  // BUN_INSTALL_CACHE_DIR переопределяет умолчание — тот же приоритет, что у bun.
  // realpathSync нужен, чтобы /tmp и /private/tmp на macOS не расходились:
  // применение разыменовывает путь, а без этого /tmp/bun не совпадало бы с
  // /private/tmp/bun, которое приходит из realpathSync в paths.ts.
  const dir = process.env.BUN_INSTALL_CACHE_DIR || join(homedir(), '.bun', 'install', 'cache');
  try {
    return realpathSync(dir);
  } catch {
    return dir; // каталог ещё не создан — возвращаем как есть
  }
}

export function outsideProjectReason({directory, real}: OutsidePackage): string {
  const cache = bunInstallCacheDir();
  const inBunStore = real === cache || real.startsWith(cache + sep);

  if (inBunStore) {
    return (
      `${directory} resolves to ${real}, outside the project — that is bun's shared store.\n` +
      `     Patching there would change the package for every project on this machine.\n` +
      `     Reinstall with the store inside the project: BUN_INSTALL_GLOBAL_STORE=0 bun install`
    );
  }

  return (
    `${directory} resolves to ${real}, outside the project.\n` +
    `     Patches are only ever written inside the project.`
  );
}

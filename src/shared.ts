import {createHash} from 'crypto';
import {existsSync, readFileSync, readdirSync, realpathSync} from 'fs';
import {join, resolve} from 'path';
import {PatchTarget, orderPatchFiles, parsePatchName, splitPatchHeader} from './patch-file';
import {packageDirectoryOf, patchesDirectory, resolvePackagePath, stripPathPrefix} from './paths';
import {displayPath, hostOfPackage, isInside, outermostPackageDir, workspaceDirectories, workspaceRoot} from './workspace';

// В монорепо два воркспейса, зависящие от одной версии пакета, приходят на один
// каталог: измерено на bun 1.4.0 — `packages/a/node_modules/is-number` и
// `packages/b/node_modules/is-number` дали один инод (191719203). Правильного
// дерева в таком случае не бывает: каталог один, а патчи разные.
//
// Что делает здесь конкурент, тоже измерено: patch-package 8.0.1 применяет и
// молчит. Заплата воркспейса `a` оказывается в дереве `b`, который её не просил,
// а поскольку patch-package пишет на месте, при `--backend=hardlink` она уезжает
// ещё и в кеш bun — то есть в следующую чистую установку любого проекта машины.
//
// Отказываем в том воркспейсе, который запустился, назвав оба патча. Исход не
// зависит от того, кто успел первым, — а успеть может любой: bun запускает
// postinstall воркспейсов параллельно (измерено, два старта совпали до
// микросекунды).
export interface SharedConflict {
  directory: string; // как записано в патче: node_modules/<pkg>
  real: string; // общий каталог на диске
  workspace: string; // воркспейс-сосед, от корня монорепо
  ourFile: string;
  theirFile: string;
}

function bodyHash(path: string): string | null {
  try {
    return createHash('sha256').update(splitPatchHeader(readFileSync(path, 'utf-8')).body).digest('hex');
  } catch {
    return null;
  }
}

// Патчи одного пакета в заданном каталоге патчей, по порядку последовательности.
// Сравнивать надо весь набор: у соседа патчей может быть больше, и тогда его
// дерево всё равно не то, даже если первые совпадают.
// Спрашивают это на каждый патч прогона — и про свой каталог, и про каталог
// каждого соседа, — а ответ за прогон не меняется: файлы патчей никто по ходу
// не переписывает. Без памяти каждый патч стоил readdir и sha256 всех патчей
// своего пакета, помноженных на число воркспейсов.
const patchesCache = new Map<string, {file: string; hash: string | null}[]>();

function patchesForPackage(patchesDir: string, packageDir: string): {file: string; hash: string | null}[] {
  const key = `${patchesDir}\u0000${packageDir}`;
  const remembered = patchesCache.get(key);
  if (remembered !== undefined) return remembered;

  const found = collectPatchesFor(patchesDir, packageDir);
  patchesCache.set(key, found);
  return found;
}

function collectPatchesFor(patchesDir: string, packageDir: string): {file: string; hash: string | null}[] {
  let files: string[];
  try {
    files = readdirSync(patchesDir).filter(file => file.endsWith('.patch'));
  } catch {
    return [];
  }

  return orderPatchFiles(files)
    .filter(file => parsePatchName(file)?.packageDir === packageDir)
    .map(file => ({file, hash: bodyHash(join(patchesDir, file))}));
}

// Каталоги пакетов, которых касается патч, — в том же виде, в каком они стоят в
// патче. Тот же обход, что у packagesOutsideProject: вопрос к патчу один и тот
// же, а ответы должны совпадать.
function packageDirsOf(targets: PatchTarget[]): string[] {
  const dirs: string[] = [];

  for (const target of targets) {
    const raw = target.newPath ?? target.oldPath;
    if (raw === null) continue;

    const directory = packageDirectoryOf(stripPathPrefix(raw));
    if (directory !== null && !dirs.includes(directory)) dirs.push(directory);
  }

  return dirs;
}

function realPathOrNull(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

// Первый найденный конфликт — его и объясняем. Перечислять все незачем: чинить
// придётся всё равно по одному, а первый уже говорит, что происходит.
export function conflictingWorkspacePatch(patchFile: string, targets: PatchTarget[]): SharedConflict | null {
  const root = workspaceRoot();
  if (root === null) return null; // не монорепо — и вопроса нет

  const here = resolve(process.cwd());
  // Сосед — тот, кто не мы и не наш родитель: запуск из подкаталога воркспейса
  // иначе сравнивал бы наши патчи с патчами самого воркспейса и объявлял бы это
  // конфликтом.
  const siblings = workspaceDirectories(root).filter(ws => !isInside(ws, here) && !isInside(here, ws));
  if (siblings.length === 0) return null;

  const ourPackageDir = parsePatchName(patchFile)?.packageDir;
  if (ourPackageDir === undefined) return null;

  for (const directory of packageDirsOf(targets)) {
    const top = outermostPackageDir(directory);
    if (top === null) continue;

    const ourReal = realPathOrNull(resolvePackagePath(directory));
    // Пакет лежит внутри самого воркспейса — он ничей больше, и делить нечего.
    if (ourReal === null || isInside(here, ourReal)) continue;

    const ours = patchesForPackage(patchesDirectory(), ourPackageDir);

    for (const workspace of siblings) {
      // Тот же ли это каталог на диске. Сравнение по разыменованному пути, а не
      // по версии из имени патча: раскладку выбирает установщик, и решать за
      // него, где пакет окажется, мы не можем.
      const theirReal = realPathOrNull(join(hostOfPackage(top, workspace), directory));
      if (theirReal !== ourReal) continue;

      const theirPatchesDir = join(workspace, patchesDirectory());
      if (!existsSync(theirPatchesDir)) continue;

      const theirs = patchesForPackage(theirPatchesDir, ourPackageDir);
      if (theirs.length === 0) continue;

      const differs = ours.length !== theirs.length
        ? (theirs[Math.min(ours.length, theirs.length)] ?? theirs[theirs.length - 1])
        : theirs.find((patch, at) => patch.hash === null || patch.hash !== ours[at].hash);

      // Побайтово тот же набор — оба воркспейса хотят от общего каталога одного
      // и того же. Это не конфликт, и мешать им незачем.
      if (differs === undefined) continue;

      return {
        directory,
        real: theirReal,
        workspace: displayPath(root, workspace),
        ourFile: patchFile,
        theirFile: differs.file,
      };
    }
  }

  return null;
}

export function sharedConflictReason(conflict: SharedConflict): string {
  return (
    `${conflict.directory} is shared with workspace ${conflict.workspace}, which patches it differently.\n` +
    `     Both resolve to ${conflict.real} — one directory, two different patches\n` +
    `     (${conflict.ourFile} here, ${conflict.theirFile} there), so whichever ran last would win.\n` +
    `     Give the two workspaces different versions of the package, or make the patches identical.`
  );
}

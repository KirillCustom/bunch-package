import {existsSync, lstatSync, readFileSync, readdirSync} from 'fs';
import {dirname, join, relative, resolve, sep} from 'path';

// Монорепо меняет ответ на вопрос «где проект». Измерено на bun 1.4.0:
// `bun install` в корне запускает postinstall каждого воркспейса **и** корня,
// каждый — со своим каталогом в cwd, и воркспейсы стартуют одновременно (два
// старта совпали до микросекунды). То есть `apply` работает из воркспейса, а
// пакет, который он патчит, лежит у корня: при умолчании — симлинком в
// `<корень>/node_modules/.bun/…`, при `--linker hoisted` — прямо в
// `<корень>/node_modules/<pkg>`, и своего node_modules у воркспейса тогда нет
// вовсе.
//
// Отсюда всё содержимое этого файла: граница «за пределы проекта не пишем»
// внутри монорепо проходит по корню воркспейсов, а не по cwd. До этой правки
// граница шла по cwd, и в монорепо отказывал каждый патч — инструмент там не
// работал вообще.

// Корень воркспейсов ищется по полю `workspaces`, а не по наличию lockfile:
// bun 1.0 и 1.1 держат его двоичным (`bun.lockb`), а `engines` обещает 1.0.
// Поле `workspaces` одинаково у bun, npm и yarn; yarn classic заворачивает его
// в объект с ключом `packages`.
function workspaceGlobs(directory: string): string[] | null {
  const manifest = join(directory, 'package.json');
  if (!existsSync(manifest)) return null;

  let parsed: any;
  try {
    parsed = JSON.parse(readFileSync(manifest, 'utf-8'));
  } catch {
    return null; // битый манифест — это не «монорепо», а поломка чужого дерева
  }

  const raw = Array.isArray(parsed?.workspaces) ? parsed.workspaces : parsed?.workspaces?.packages;
  if (!Array.isArray(raw)) return null;

  const globs = raw.filter((entry: unknown): entry is string => typeof entry === 'string' && entry !== '');
  return globs.length > 0 ? globs : null;
}

// Ответ не меняется за время прогона: cwd процесса мы не переставляем, а тесты
// зовут CLI отдельным процессом на каждый случай. Ключ всё-таки от каталога —
// внутрисессионные вызовы из разных мест не должны получать чужой ответ.
const rootCache = new Map<string, string | null>();

// Ближайший предок (включая сам каталог), объявивший воркспейсы и назвавший
// среди них нас. `null` — обычный проект: тогда во всём остальном коде ничего
// не меняется ни на байт.
//
// Одного поля `workspaces` у предка мало. Забытый `package.json` в домашнем
// каталоге — вещь обычная, и, поверь мы ему на слово, границей проекта стал бы
// весь `~`: поиск пакета ушёл бы туда, а отказ «за пределами проекта» перестал
// бы срабатывать там, где он и нужен. Поэтому корень принимается, только если
// мы действительно лежим в объявленном им воркспейсе.
export function workspaceRoot(from: string = process.cwd()): string | null {
  const cached = rootCache.get(from);
  if (cached !== undefined) return cached;

  const start = resolve(from);
  let at = start;
  let found: string | null = null;

  for (;;) {
    if (workspaceGlobs(at) !== null && claimsDirectory(at, start)) {
      found = at;
      break;
    }
    const up = dirname(at);
    if (up === at) break;
    at = up;
  }

  rootCache.set(from, found);
  return found;
}

function claimsDirectory(root: string, directory: string): boolean {
  return directory === root || workspaceDirectories(root).some(ws => isInside(ws, directory));
}

// Корень, по которому проверяется «внутри проекта». Вне монорепо — cwd, как и
// было. DEC-13 так эту границу и описывает: стор внутри проекта законен, «даже
// когда его делят воркспейсы монорепо».
export function projectRoot(): string {
  return workspaceRoot() ?? process.cwd();
}

// Первое звено пути из патча: `node_modules/ms`, `node_modules/@scope/pkg`.
// Именно оно решает, чей node_modules держит пакет: вложенная зависимость
// (`node_modules/foo/node_modules/bar`) живёт внутри внешнего пакета и уезжает
// вместе с ним.
export function outermostPackageDir(relativePath: string): string | null {
  const parts = relativePath.split('/');
  if (parts[0] !== 'node_modules') return null;

  const depth = parts[1]?.startsWith('@') ? 3 : 2;
  return parts.length < depth ? null : parts.slice(0, depth).join('/');
}

function installedAt(directory: string): boolean {
  // lstat, а не existsSync: при изолированной раскладке это симлинк, и битая
  // ссылка тоже считается установленным пакетом — про неё скажет разбор дальше.
  try {
    lstatSync(directory);
    return true;
  } catch {
    return false;
  }
}

// Каталог, чей `node_modules` держит пакет. Вне монорепо — всегда cwd. Внутри —
// поиск вверх до корня воркспейсов: ровно то, о чём просят в patch-package #356
// («искать в node_modules родителя»). Измерено, зачем это нужно: при
// `--linker hoisted` пакет поднимается в корень, и у воркспейса своего
// node_modules нет — `create ms` отвечал «not found» на установленный пакет, а
// patch-package 8.0.1 в том же месте падает стеком Node.
//
// Не нашли нигде — отвечаем cwd, чтобы диагностика осталась прежней: «пакета
// нет» скажет тот, у кого для этого есть слова.
// Ответ спрашивают на каждый путь из патча, а путей в патче бывают сотни, и
// каждый ответ — обход вверх с lstat на каждом шаге. Кеш тот же по смыслу, что
// у rootCache: каталог пакета за прогон не появляется и не исчезает — apply
// правит файлы внутри пакета, а не заводит и не сносит его каталог.
const hostCache = new Map<string, string>();

export function hostOfPackage(packageDir: string, from: string = process.cwd()): string {
  const key = `${from}\u0000${packageDir}`;
  const remembered = hostCache.get(key);
  if (remembered !== undefined) return remembered;

  const found = findHost(packageDir, from);
  hostCache.set(key, found);
  return found;
}

function findHost(packageDir: string, from: string): string {
  const root = workspaceRoot(from);
  if (root === null) return from;

  let at = resolve(from);
  for (;;) {
    if (installedAt(join(at, packageDir))) return at;
    if (at === root) return from;

    const up = dirname(at);
    if (up === at) return from;
    at = up;
  }
}

// То же самое для пути из патча целиком: `node_modules/ms/index.js`.
export function hostOfPatchPath(relativePath: string, from: string = process.cwd()): string {
  const top = outermostPackageDir(relativePath);
  return top === null ? from : hostOfPackage(top, from);
}

// Каталоги воркспейсов монорепо. Список нужен ровно затем, чтобы узнать, не
// патчит ли сосед тот же общий каталог иначе, — и берётся он из `workspaces`
// корневого манифеста, а не из lockfile: формат lockfile у bun менялся, поле
// `workspaces` — нет.
const directoriesCache = new Map<string, string[]>();

export function workspaceDirectories(root: string): string[] {
  const cached = directoriesCache.get(root);
  if (cached !== undefined) return cached;

  const found = expandWorkspaces(root);
  directoriesCache.set(root, found);
  return found;
}

// Раскрутка шаблонов обходит каталоги, а спрашивают её на каждый патч: сперва
// про корень воркспейсов, потом про соседей. Без памяти это readdir на файл.
function expandWorkspaces(root: string): string[] {
  const globs = workspaceGlobs(root);
  if (globs === null) return [];

  const found: string[] = [];

  for (const glob of globs) {
    for (const directory of expandGlob(root, glob.split('/').filter(part => part !== ''))) {
      if (existsSync(join(directory, 'package.json')) && !found.includes(directory)) {
        found.push(directory);
      }
    }
  }

  return found;
}

// Из всего синтаксиса шаблонов здесь встречаются только `*` и `**`: `packages/*`,
// `apps/*`, `packages/**`. Своя раскрутка — потому что зависимостей во время
// работы у проекта нет, а `Bun.Glob` появился не в 1.0, которую обещает
// `engines`.
function expandGlob(base: string, segments: string[]): string[] {
  if (segments.length === 0) return [base];

  const [head, ...rest] = segments;

  if (head === '**') {
    // `**` покрывает и «ноль каталогов»: `packages/**` включает сам packages.
    const here = expandGlob(base, rest);
    return [...here, ...subdirectories(base).flatMap(child => expandGlob(child, segments))];
  }

  if (head === '*') {
    return subdirectories(base).flatMap(child => expandGlob(child, rest));
  }

  const next = join(base, head);
  return existsSync(next) ? expandGlob(next, rest) : [];
}

function subdirectories(directory: string): string[] {
  try {
    return readdirSync(directory, {withFileTypes: true})
      .filter(entry => entry.isDirectory() && entry.name !== 'node_modules' && !entry.name.startsWith('.'))
      .map(entry => join(directory, entry.name));
  } catch {
    return [];
  }
}

export function isInside(root: string, path: string): boolean {
  return path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);
}

// Путь для сообщения: `packages/a` читается, абсолютный — нет.
export function displayPath(root: string, path: string): string {
  const rel = relative(root, path);
  return rel === '' ? '.' : rel.split(sep).join('/');
}

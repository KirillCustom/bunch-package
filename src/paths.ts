import {chmodSync, existsSync, mkdirSync, realpathSync, renameSync, rmSync, writeFileSync} from 'fs';
import {resolve, sep} from 'path';
import {hostOfPatchPath, projectRoot} from './workspace';

// Каталог патчей по умолчанию тот же, что у patch-package, — патчи ходят между
// инструментами. Монорепозиторию этого мало: воркспейсам нужен свой каталог на
// каждый, отсюда --patch-dir. Значение живёт здесь, а не передаётся параметром
// через все команды: его спрашивают девять мест, и девять лишних параметров
// стоили бы дороже одной переменной, которую выставляют один раз при разборе
// аргументов.
const DEFAULT_PATCHES_DIR = 'patches';

let patchesDir = DEFAULT_PATCHES_DIR;

export function patchesDirectory(): string {
  return patchesDir;
}

// Каталог приходит из командной строки и попадает прямо в пути записи, поэтому
// проверяем его тем же правилом, что и пути внутри патча.
export function usePatchesDirectory(dir: string): void {
  if (dir === '') throw new Error('--patch-dir needs a directory name');

  resolveInsideProject(dir);
  patchesDir = dir;
}

// Файлы пишутся рядом с целью и переставляются поверх неё, поэтому в дереве
// пакета на мгновение появляется вот такой сосед. Если apply убьют ровно тогда,
// сосед останется лежать — и не должен ни попасть в следующий патч, ни быть
// принят за файл пакета. Суффикс знают оба: apply, который его создаёт, и
// create, который его исключает из диффа.
export const TEMP_WRITE_SUFFIX = '.bunch-tmp-';

// mkdir с recursive по спецификации молчит, если каталог уже есть. bun 1.1
// вместо этого бросал EEXIST — и `apply` падал на ровном месте: «EEXIST: file
// already exists, mkdir 'node_modules'», ноль применённых патчей. Проверено на
// bun 1.0, 1.1, 1.2 и 1.4; ловить EEXIST самим дешевле, чем требовать версию.
export function ensureDir(path: string): void {
  try {
    mkdirSync(path, {recursive: true});
  } catch (error: any) {
    if (error.code !== 'EEXIST') throw error;
  }
}

// -p1: срезаем первый компонент пути, как это делает patch.
export function stripPathPrefix(path: string): string {
  const slash = path.indexOf('/');
  return slash === -1 ? path : path.slice(slash + 1);
}

// Единственная защита от выхода за корень проекта. Полагаться здесь на patch(1)
// было нельзя: GNU такие пути отвергает, Apple спокойно пишет файл наружу.
export function resolveInside(root: string, relativePath: string): string {
  const resolved = resolve(root, relativePath);
  if (resolved !== root && !resolved.startsWith(root + sep)) {
    throw new Error(`refusing to touch ${relativePath} — it resolves outside the project`);
  }
  return resolved;
}

// Для путей, которые принадлежат самому каталогу запуска: --patch-dir и всё,
// что пишется рядом с патчами. Корень воркспейсов тут ни при чём — патчи
// воркспейса лежат в воркспейсе.
export function resolveInsideProject(relativePath: string): string {
  return resolveInside(process.cwd(), relativePath);
}

// Путь из патча (`node_modules/<pkg>/<файл>`) — на место, где пакет установлен.
// Вне монорепо это по-прежнему cwd; внутри пакет может быть поднят к корню, и
// тогда путь ложится туда. Формат патча от этого не меняется ни на байт: в нём
// как стояло `node_modules/<pkg>/…`, так и стоит, — иначе патчи перестали бы
// ходить между нами и patch-package.
export function resolvePackagePath(relativePath: string): string {
  return resolveInside(hostOfPatchPath(relativePath), relativePath);
}

// Каталог установленного пакета по его имени: `ms`, `@scope/pkg` или путь
// вложенной зависимости `foo/node_modules/bar`. Разделитель здесь всегда `/` —
// путь строится в том же виде, в каком он стоит в патче, и только
// resolvePackagePath превращает его в путь файловой системы.
export function installedPackagePath(packageName: string): string {
  return resolvePackagePath(`node_modules/${packageName}`);
}

// Есть ли пакет на диске: спрашивается путём из патча, а отвечать надо про то
// место, где он на самом деле установлен.
export function packageInstalled(packageDir: string): boolean {
  try {
    return existsSync(resolvePackagePath(packageDir));
  } catch {
    return false; // путь наружу — про это скажет resolvePackagePath у вызывающего
  }
}

// Путь бывает внутри проекта по написанию и снаружи — на диске. `bun install
// --linker isolated` с включённым глобальным стором (`BUN_INSTALL_GLOBAL_STORE=1`
// или `install.globalStore` в bunfig) кладёт в node_modules симлинк, ведущий в
// `<кеш>/links/…` — каталог, общий для всех проектов машины.
//
// Измерено на bun 1.4.0: наш `apply` писал туда молча, и второй проект, ничего
// не знавший о патче, приезжал с чужой заплатой уже при обычной установке. Сам
// bun в этом месте отцепляет каталог от общего стора и отказывается патчить
// сквозь него — «refusing to patch through it».
//
// resolveInsideProject здесь бессилен: путь `node_modules/ms/index.js` внутри
// проекта по написанию, и только разыменование показывает, куда он ведёт.
export function realPathOutsideProject(relativePath: string): string | null {
  // Граница — корень воркспейсов, если мы внутри монорепо. Иначе `.bun` у корня
  // читался бы как чужой стор: он лежит выше cwd воркспейса, и до этой правки
  // `apply` отказывал там на каждом патче. DEC-13 объявляет такой стор законным.
  const root = realpathSync(projectRoot());

  let real: string;
  try {
    real = realpathSync(resolve(hostOfPatchPath(relativePath), relativePath));
  } catch {
    // Пути нет на диске — это другой разговор, и его ведёт проверка «пакет не
    // установлен»: у неё и диагноз точнее.
    return null;
  }

  return real === root || real.startsWith(root + sep) ? null : real;
}

// Каталог пакета, которому принадлежит путь. Идём до самого внутреннего:
// `node_modules/foo/node_modules/bar/index.js` — это файл bar, а не foo. Пока
// брался первый, патч вложенной зависимости сверялся с манифестом внешнего
// пакета и на каждый `bun install` печаталось ложное `version mismatch`.
export function packageDirectoryOf(relativePath: string): string | null {
  const parts = relativePath.split('/');
  if (parts[0] !== 'node_modules') return null;

  let at = 0;
  let directory: string | null = null;

  while (parts[at] === 'node_modules') {
    // У пакета со скоупом имя занимает два сегмента: `@scope/pkg`.
    const depth = parts[at + 1]?.startsWith('@') ? 3 : 2;
    if (parts.length < at + depth) return directory;

    directory = parts.slice(0, at + depth).join('/');
    at += depth;
  }

  return directory;
}

// Как и git, из всех прав отслеживаем только бит исполнения: сравнивать полные
// режимы нельзя — у распакованного эталона и у node_modules разный umask.
const EXECUTABLE = 0o111;

// На Windows бита исполнения не существует: NTFS его не хранит, chmod почти
// no-op, а statSync возвращает одинаковый режим всем файлам. Без этой проверки
// apply каждый раз видел бы «нужно выставить бит», звал chmod вхолостую и
// бесконечно рапортовал о проделанной работе. Патч со сменой режима, приехавший
// с macOS или Linux, должен применяться там молча и ровно один раз.
export const MODES_SUPPORTED = process.platform !== 'win32';

export function isExecutable(mode: number): boolean {
  return (mode & EXECUTABLE) !== 0;
}

export function withExecutable(mode: number, executable: boolean): number {
  return executable ? mode | EXECUTABLE : mode & ~EXECUTABLE;
}

// Пишем рядом и переставляем поверх. rename в пределах каталога атомарен:
// снаружи файл виден либо старым целиком, либо новым целиком, и убитый посреди
// работы процесс не оставляет ни обрезка, ни дыры на его месте. Заодно это
// разрывает hardlink на общий кеш bun — у временного файла свой инод.
export function atomicWrite(file: string, content: string | Uint8Array, mode: number | null = null): void {
  const temp = `${file}${TEMP_WRITE_SUFFIX}${process.pid}`;

  try {
    writeFileSync(temp, content);
    // Режим ставим до перестановки, чтобы файл не побывал видимым с чужим.
    if (mode !== null) chmodSync(temp, mode);
    renameSync(temp, file);
  } catch (error) {
    rmSync(temp, {force: true});
    throw error;
  }
}

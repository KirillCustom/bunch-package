import {mkdirSync} from 'fs';
import {resolve, sep} from 'path';

export const PATCHES_DIR = 'patches';

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
export function resolveInsideProject(relativePath: string): string {
  const root = process.cwd();
  const resolved = resolve(root, relativePath);
  if (resolved !== root && !resolved.startsWith(root + sep)) {
    throw new Error(`refusing to touch ${relativePath} — it resolves outside the project`);
  }
  return resolved;
}

export function packageDirectoryOf(relativePath: string): string | null {
  const parts = relativePath.split('/');
  if (parts[0] !== 'node_modules' || parts.length < 2) return null;
  const depth = parts[1].startsWith('@') ? 3 : 2;
  return parts.slice(0, depth).join('/');
}

// Как и git, из всех прав отслеживаем только бит исполнения: сравнивать полные
// режимы нельзя — у распакованного эталона и у node_modules разный umask.
export const EXECUTABLE = 0o111;

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
  return executable ? mode | 0o111 : mode & ~0o111;
}

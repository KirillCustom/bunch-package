import {closeSync, mkdirSync, openSync, readFileSync, rmSync, writeSync} from 'fs';
import {join} from 'path';

// Два apply одновременно — не выдумка: postinstall срабатывает на каждый
// `bun install`, а в монорепозитории воркспейсы ставятся параллельно.
//
// Измерено на последовательности из трёх патчей по 300 файлов: при сдвиге
// второго запуска на 60 мс дерево осталось в состоянии, которого нет ни до, ни
// после — файлы, удалённые третьим патчем, воскресил сосед, применявший второй.
// На меньших сдвигах оба процесса ругались `ENOENT ... chmod` на файл, который
// сосед успел снести между записью и сменой режима.
//
// Патч применяется целиком или не применяется вовсе — это верно внутри одного
// процесса и должно быть верно между процессами. Отсюда замок.
export const LOCK_FILE = join('node_modules', '.bunch-package.lock');
export const LOCK_WAIT_MS = 30_000;

const POLL_MS = 50;

// Весь apply синхронный, поэтому и ждать надо синхронно. Atomics.wait на
// пустом разделяемом буфере — единственный способ, который не зависит ни от
// платформы, ни от рантайма.
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function holderOf(lockFile: string): string {
  try {
    const pid = readFileSync(lockFile, 'utf-8').trim();
    return pid === '' ? 'unknown pid' : `pid ${pid}`;
  } catch {
    return 'unknown pid'; // замок мог исчезнуть прямо сейчас — это не наше дело
  }
}

export function withApplyLock<T>(lockFile: string, run: () => T, waitMs: number = LOCK_WAIT_MS): T {
  mkdirSync(join(lockFile, '..'), {recursive: true});
  const deadline = Date.now() + waitMs;

  let handle: number;
  for (;;) {
    try {
      // 'wx' — это O_CREAT|O_EXCL: либо файл создан нами, либо отказ. Проверять
      // существование заранее нельзя, между проверкой и созданием помещается
      // ровно та гонка, от которой мы защищаемся.
      handle = openSync(lockFile, 'wx');
      break;
    } catch (error: any) {
      if (error.code !== 'EEXIST') throw error;

      if (Date.now() >= deadline) {
        throw new Error(
          `another \`bunch-package apply\` is running: ${lockFile} is held by ${holderOf(lockFile)}. ` +
            `If no such process exists, that file is left over from a killed run — delete it.`,
        );
      }
      sleepSync(POLL_MS);
    }
  }

  try {
    writeSync(handle, `${process.pid}\n`);
  } finally {
    closeSync(handle);
  }

  try {
    return run();
  } finally {
    rmSync(lockFile, {force: true});
  }
}

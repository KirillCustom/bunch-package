import {closeSync, openSync, readFileSync, renameSync, rmSync, writeSync} from 'fs';
import {join} from 'path';
import {ensureDir} from './paths';

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
const LOCK_WAIT_MS = 30_000;

const POLL_MS = 50;

// Весь apply синхронный, поэтому и ждать надо синхронно. Atomics.wait на
// пустом разделяемом буфере — единственный способ, который не зависит ни от
// платформы, ни от рантайма.
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function holderOf(lockFile: string): number | null {
  try {
    const pid = Number(readFileSync(lockFile, 'utf-8').trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null; // замок мог исчезнуть прямо сейчас — это не наше дело
  }
}

// Сигнал 0 ничего не посылает, а только спрашивает, есть ли такой процесс.
// EPERM означает «есть, но чужой» — это тоже «жив».
function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: any) {
    return error.code === 'EPERM';
  }
}

// Замок переживает SIGKILL: finally при нём не исполняется. Без разбора
// протухших замков убитый apply запирал бы проект насовсем — а убивают его
// ровно там, где чинить некому (упавший CI, Ctrl-C, конец места на диске).
//
// Снимаем через переименование, а не через удаление: rename атомарен, поэтому
// из двух процессов, увидевших один и тот же протухший замок, файл уносит ровно
// один. Второй получит ENOENT и просто пойдёт на новый круг.
function dropStaleLock(lockFile: string, pid: number): boolean {
  const claimed = `${lockFile}.stale-${process.pid}`;
  try {
    renameSync(lockFile, claimed);
  } catch {
    return false; // кто-то опередил — не наше дело
  }
  rmSync(claimed, {force: true});
  console.log(`  ⚠️  removed a stale lock left by pid ${pid}, which is no longer running`);
  return true;
}

export function withApplyLock<T>(lockFile: string, run: () => T, waitMs: number = LOCK_WAIT_MS): T {
  ensureDir(join(lockFile, '..'));
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

      const holder = holderOf(lockFile);
      if (holder !== null && !isRunning(holder) && dropStaleLock(lockFile, holder)) {
        continue; // замок был ничей — пробуем занять его тем же кругом
      }

      if (Date.now() >= deadline) {
        throw new Error(
          `another \`bunch-package apply\` is running: ${lockFile} is held by ` +
            `${holder === null ? 'an unknown pid' : `pid ${holder}`}. ` +
            `If no such process exists, that file is left over from a killed run — delete it.`,
        );
      }
      sleepSync(POLL_MS);
    }
  }

  // Между созданием файла и записью pid есть щель шириной в несколько
  // микросекунд: убитый ровно там apply оставит замок без владельца, и разобрать
  // его как протухший будет нечем — придётся ждать до конца и читать сообщение.
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

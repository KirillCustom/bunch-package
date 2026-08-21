import {createHash} from 'crypto';
import {existsSync, readFileSync, renameSync, rmSync, writeFileSync} from 'fs';
import {join} from 'path';

// Запись о том, что и когда легло в дерево. Нужна затем, чтобы на вопрос «что
// сейчас в node_modules» был ответ, не требующий разбирать патчи глазами.
//
// Лежит рядом с замком, а не внутри каталога пакета: patch-package кладёт свой
// `.patch-package.json` прямо в пакет, и такой файл попадает в дифф следующего
// патча — при разборе его исходников это видно, и повторять это незачем.
// Заодно у записи ровно та же жизнь, что у node_modules, которые она описывает.
export const STATE_FILE = join('node_modules', '.bunch-package-state.json');

const VERSION = 1;

export interface RecordedPatch {
  file: string; // имя файла в patches/
  packageDir: string; // каталог в node_modules, со слэшем для скоупа
  version: string;
  sha256: string; // хеш файла патча на момент применения
  appliedAt: string; // ISO-8601
}

export interface State {
  version: number;
  patches: RecordedPatch[];
}

export function hashPatchFile(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

// Запись — это только запись. Считать по ней, что патч на месте, нельзя:
// файлы в node_modules меняются мимо нас, и единственное настоящее
// доказательство — обратное применение к самому дереву.
export function readState(stateFile: string = STATE_FILE): State | null {
  if (!existsSync(stateFile)) return null;

  try {
    const parsed = JSON.parse(readFileSync(stateFile, 'utf-8'));
    if (parsed?.version !== VERSION || !Array.isArray(parsed.patches)) return null;
    return parsed as State;
  } catch {
    // Битую запись молча заменим следующим apply: это не источник истины, и
    // ронять из-за неё прогон было бы обидно.
    return null;
  }
}

export function writeState(patches: RecordedPatch[], stateFile: string = STATE_FILE): void {
  const state: State = {version: VERSION, patches};
  const temp = `${stateFile}.tmp-${process.pid}`;

  try {
    writeFileSync(temp, JSON.stringify(state, null, 2) + '\n');
    renameSync(temp, stateFile);
  } catch (error) {
    rmSync(temp, {force: true});
    throw error;
  }
}

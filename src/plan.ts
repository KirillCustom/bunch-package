import {chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync, type Stats} from 'fs';
import {join} from 'path';
import {applyHunks} from './hunks';
import {PatchTarget, sideLines} from './patch-file';
import {MODES_SUPPORTED, TEMP_WRITE_SUFFIX, isExecutable, packageDirectoryOf, resolveInsideProject, stripPathPrefix, withExecutable} from './paths';

// Режим симлинка в git-заголовках. У обычных файлов — 100644 и 100755.
export const SYMLINK_MODE = '120000';

export type PlannedOp =
  | {kind: 'write'; file: string; content: string; mode: number | null}
  | {kind: 'remove'; file: string}
  | {kind: 'chmod'; file: string; mode: number}
  | {kind: 'rename'; from: string; to: string};

function lstatOrNull(file: string): Stats | null {
  try {
    return lstatSync(file);
  } catch (error: any) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
    throw error;
  }
}

// По умолчанию патч ложится на корень проекта. Но при создании следующего патча
// в последовательности те же самые секции нужно наложить на распакованный эталон
// — иначе новый патч содержал бы и правки предыдущих. Отсюда второй режим:
// пути вида node_modules/<пакет>/<путь> отображаются внутрь заданного каталога.
export interface TreeContext {
  root: string;
  prefix: string; // `node_modules/<пакет>/`
}

// Пустой файл — это чаще всего создаваемый. Текстовый файл принято завершать
// переводом строки, и отсутствие маркера `\ No newline` означает именно его;
// без этого умолчания создаваемые файлы рождались без перевода строки.
export function splitContent(raw: string): {lines: string[]; endsWithNewline: boolean} {
  const lines = raw === '' ? [] : raw.split('\n');
  const endsWithNewline = lines.length === 0 || lines[lines.length - 1] === '';
  if (lines.length > 0 && endsWithNewline) lines.pop();
  return {lines, endsWithNewline};
}

// Самая заковыристая часть плана: решить, что стало с содержимым файла.
// Вынесена отдельно — здесь нет ни путей, ни файловой системы сверх чтения, и
// именно тут сидели почти все дефекты, которые нашёл корпусный прогон.
type ContentPlan = {kind: 'ops'; ops: PlannedOp[]} | {kind: 'remove'; file: string};

function planContentChange(
  target: PatchTarget,
  relativePath: string,
  source: string,
  file: string,
  exists: boolean,
  currentMode: number | null,
  wantExecutable: boolean | null,
  assumeNotApplied: boolean,
): ContentPlan {
  const raw = exists ? readFileSync(source, 'utf-8') : '';
  const {lines, endsWithNewline} = splitContent(raw);

  // Патч создаёт файл, а файл уже есть и не пуст — применять такое вслепую
  // значит подмешать содержимое к чужому файлу.
  const isCreation = target.oldPath === null || target.hunks.every(h => sideLines(h, 'old').length === 0);
  let alreadyApplied = false;

  if (isCreation && exists && raw !== '') {
    const reverse = applyHunks(lines, endsWithNewline, target.hunks, true, false);
    if ('error' in reverse) throw new Error(`${relativePath} already exists`);
    alreadyApplied = true;
  } else {
    // «Уже применён» проверяем обратным применением, а не прямым: патч, который
    // только дописывает строки, ложится вперёд и во второй раз — так дублировалось
    // содержимое файлов.
    //
    // Но у патча на удаление новая сторона пуста, а пустой образец совпадает с чем
    // угодно, поэтому для него обратная проверка ничего не значит: там признак
    // применённости — отсутствующий или пустой файл.
    const hasNewContent = target.hunks.some(h => sideLines(h, 'new').length > 0);

    if (assumeNotApplied) {
      // Откат зовёт нас с уже перевёрнутым патчем, установив этот флаг, потому
      // что применённость исходного патча он проверил сам — и проверить её
      // здесь заново нечем. Обратная проверка для перевёрнутого патча значит
      // «прямое применение сходится», а у патча, который только дописывает
      // строки, оно сходится и когда патч уже лежит: контекст-то на месте.
      alreadyApplied = false;
    } else if (!hasNewContent) {
      alreadyApplied = !exists || raw === '';
    } else {
      const reverse = applyHunks(lines, endsWithNewline, target.hunks, true, false);
      alreadyApplied = !('error' in reverse);
    }
  }

  if (!alreadyApplied) {
    const forward = applyHunks(lines, endsWithNewline, target.hunks, false);
    if ('error' in forward) throw new Error(`${relativePath}: ${forward.error}`);

    const content = forward.lines.join('\n') + (forward.endsWithNewline ? '\n' : '');

    // patch(1) удаляет файл, от которого ничего не осталось. Повторяем это, иначе
    // патч на удаление оставлял пустышку и ломал каждый следующий прогон.
    if (content === '' || content === '\n') {
      return {kind: 'remove', file};
    }

    // Запись идёт не в тот же файл, а во временный рядом (см. executeOps),
    // чтобы разорвать hardlink на общий кеш bun, — а значит режим надо
    // проставить заново, иначе бит исполнения терялся бы у любого патченого файла.
    const base = currentMode ?? 0o644;
    const mode = wantExecutable === null ? base : withExecutable(base, wantExecutable);
    return {kind: 'ops', ops: [{kind: 'write', file, content, mode}]};
  }

  return {kind: 'ops', ops: []};
}

// assumeNotApplied выставляет только откат: он уже убедился, что исходный патч
// лежит в дереве, и внутренняя проверка применённости для перевёрнутого патча
// дала бы неверный ответ — см. planContentChange().
export function planTarget(
  target: PatchTarget,
  context?: TreeContext,
  assumeNotApplied = false,
): PlannedOp[] {
  const rawPath = target.newPath ?? target.oldPath ?? target.renameTo;
  if (rawPath === null) throw new Error('patch section has no file path');

  const relativePath = stripPathPrefix(rawPath);

  // Симлинк git записывает режимом 120000, а содержимым — цель ссылки. Запись
  // «как есть» подменила бы ссылку обычным файлом, внутри которого лежал бы
  // путь: apply рапортовал бы успех, а в дереве оказалось бы не то. Отказываем
  // вслух — patch-package такие патчи тоже не применяет.
  if (target.newMode === SYMLINK_MODE || target.oldMode === SYMLINK_MODE) {
    throw new Error(`${relativePath} is a symbolic link (mode ${SYMLINK_MODE}) — bunch-package cannot apply that`);
  }

  let file: string;
  if (context === undefined) {
    file = resolveInsideProject(relativePath);

    const packageDir = packageDirectoryOf(relativePath);
    if (packageDir !== null && !existsSync(packageDir)) {
      throw new Error(`${packageDir} is not installed`);
    }
  } else {
    if (!relativePath.startsWith(context.prefix)) {
      throw new Error(`${relativePath} does not belong to ${context.prefix}`);
    }
    file = join(context.root, relativePath.slice(context.prefix.length));
  }

  // Переименование выполняется до всего остального: содержимое, если оно тоже
  // менялось, читается из старого файла, а пишется уже в новый.
  const renameOps: PlannedOp[] = [];
  let source = file;

  if (target.renameFrom !== null && target.renameTo !== null && context === undefined) {
    const from = resolveInsideProject(target.renameFrom);
    const to = resolveInsideProject(target.renameTo);

    if (existsSync(from)) {
      renameOps.push({kind: 'rename', from, to});
      source = from;
      file = to;
    } else if (existsSync(to)) {
      source = to; // уже переименован
      file = to;
    } else {
      throw new Error(`${target.renameFrom} is missing`);
    }
  }

  // lstat, а не stat: у симлинка нас интересует он сам, а не то, куда он ведёт.
  // Заодно это ловит битую ссылку, которую existsSync считает отсутствующим
  // файлом — записать поверх неё обычный файл значило бы съесть ссылку молча.
  const status = lstatOrNull(source);
  if (status !== null && status.isSymbolicLink()) {
    throw new Error(`${relativePath} is a symbolic link on disk — bunch-package will not replace it with a file`);
  }

  const exists = status !== null;
  const currentMode = status?.mode ?? null;
  const wantExecutable =
    target.newMode === null || !MODES_SUPPORTED ? null : target.newMode === '100755';

  // Файл удаляется — это сказано заголовком, а не выведено из пустого результата.
  if (target.newPath === null || (target.hunks.length === 0 && target.deletedFile)) {
    return exists ? [...renameOps, {kind: 'remove', file: source}] : [];
  }

  // `new file mode` без единого хунка — это создание пустого файла: содержимого
  // нет, поэтому и хунков нет. Раньше такая секция принималась за смену режима у
  // отсутствующего файла и роняла весь патч. В реальных патчах это встречается —
  // так в них попадают пустые артефакты сборки.
  if (target.hunks.length === 0 && target.newFile) {
    if (exists) return [...renameOps];
    return [...renameOps, {kind: 'write', file, content: '', mode: wantExecutable === true ? 0o755 : 0o644}];
  }

  const ops: PlannedOp[] = [...renameOps];

  if (target.hunks.length > 0) {
    const plan = planContentChange(
      target,
      relativePath,
      source,
      file,
      exists,
      currentMode,
      wantExecutable,
      assumeNotApplied,
    );
    if (plan.kind === 'remove') return [{kind: 'remove', file: plan.file}];
    ops.push(...plan.ops);
  }

  // Смена режима без изменения содержимого — отдельная секция патча.
  if (wantExecutable !== null && !ops.some(op => op.kind === 'write')) {
    if (currentMode === null) throw new Error(`${relativePath}: cannot change mode, file is missing`);
    if (isExecutable(currentMode) !== wantExecutable) {
      ops.push({kind: 'chmod', file, mode: withExecutable(currentMode, wantExecutable)});
    }
  }

  return ops;
}

export function executeOps(ops: PlannedOp[]): void {
  for (const op of ops) {
    if (op.kind === 'remove') {
      rmSync(op.file, {force: true});
      continue;
    }
    if (op.kind === 'chmod') {
      chmodSync(op.file, op.mode);
      continue;
    }
    if (op.kind === 'rename') {
      mkdirSync(join(op.to, '..'), {recursive: true});
      renameSync(op.from, op.to);
      continue;
    }
    mkdirSync(join(op.file, '..'), {recursive: true});

    // Пишем рядом и переставляем поверх. rename в пределах каталога атомарен:
    // снаружи файл виден либо старым целиком, либо новым целиком. Прежняя
    // последовательность «удалить, записать, выставить режим» оставляла между
    // шагами дыру: apply, убитый там (Ctrl-C, упавший CI, кончившееся место),
    // оставлял файл исчезнувшим или обрезанным — а из такого состояния патч
    // больше не ложился никогда, потому что хунк не сходился с пустотой.
    //
    // Hardlink на общий кеш bun это разрывает ровно так же, как прежнее
    // пересоздание: у временного файла свой инод, а rename меняет только запись
    // в каталоге, оставляя кешу его собственный.
    const temp = `${op.file}${TEMP_WRITE_SUFFIX}${process.pid}`;
    try {
      writeFileSync(temp, op.content);
      // Режим ставим до перестановки, чтобы файл не побывал видимым с чужим.
      if (op.mode !== null) chmodSync(temp, op.mode);
      renameSync(temp, op.file);
    } catch (error) {
      rmSync(temp, {force: true});
      throw error;
    }
  }
}

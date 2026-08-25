import {Hunk, sideLines} from './patch-file';

// Хунк ищем сначала там, где он объявлен, потом расходящимся поиском — ровно как
// это делает patch со смещением. Нечёткого совпадения (fuzz) не допускаем: патч
// делался под конкретную версию, и подгонять контекст молча — это как раз то,
// из-за чего провалы выглядели успехами.
// Хвостовые пробелы теряются по дороге: их срезают редакторы, линтеры и
// веб-интерфейс GitHub. Строка с одним лишь отступом превращается в пустую, и
// патч перестаёт прикладываться, хотя ничего значимого не изменилось. На корпусе
// из 269 реальных патчей это была причина девяти отказов из семнадцати.
// patch-package сравнивает строки так же — и всегда, а не как запасной вариант.
function linesEqual(a: string, b: string): boolean {
  return a === b || a.replace(/\s+$/, '') === b.replace(/\s+$/, '');
}

function locateHunk(lines: string[], needle: string[], preferred: number, search = true): number {
  const fits = (at: number): boolean =>
    at >= 0 &&
    at + needle.length <= lines.length &&
    needle.every((line, index) => linesEqual(lines[at + index], line));

  if (needle.length === 0) return Math.max(0, Math.min(preferred, lines.length));
  if (fits(preferred)) return preferred;
  if (!search) return -1;

  for (let distance = 1; distance <= lines.length; distance++) {
    if (fits(preferred - distance)) return preferred - distance;
    if (fits(preferred + distance)) return preferred + distance;
  }
  return -1;
}

export interface AppliedFile {
  lines: string[];
  endsWithNewline: boolean;
  // Насколько далеко от объявленных мест сели хунки, суммарно. Ноль означает,
  // что патч сошёлся ровно там, где написано. По этому числу решается, применён
  // патч или нет: см. looksApplied() в plan.ts.
  displacement: number;
}

// Перевод строки, каким его знает этот кусок файла: `\r` у CRLF, пустая строка
// у LF, null — если решать не по чему. Строки уже разрезаны по `\n`, поэтому у
// CRLF-файла каждая оканчивается на `\r`.
function endingOf(lines: string[]): string | null {
  let crlf = 0;
  let lf = 0;
  for (const line of lines) (line.endsWith('\r') ? crlf++ : lf++);

  if (crlf === 0 && lf === 0) return null;
  return crlf > lf ? '\r' : '';
}

function withEnding(line: string, ending: string | null): string {
  if (ending === null) return line;
  const bare = line.endsWith('\r') ? line.slice(0, -1) : line;
  return bare + ending;
}

// Строки контекста берём из файла, а не из патча. Патч намерен изменить только
// строки с + и -, а контекст он лишь описывает — и описывает неточно, если по
// дороге у него срезали хвостовые пробелы. Раньше диапазон пересобирался целиком
// из «новой стороны», и такие расхождения уехали бы в файл.
function buildReplacement(
  hunk: Hunk,
  lines: string[],
  at: number,
  reverse: boolean,
  // Приводить ли строки, взятые из патча, к переводу строки файла. Нужно только
  // откату: там патч — единственный источник восстанавливаемых строк.
  matchFileEndings = false,
): string[] {
  const removePrefix = reverse ? '+' : '-';
  const insertPrefix = reverse ? '-' : '+';
  const out: string[] = [];
  let index = at;

  // Стиль спрашиваем у строк контекста: они пришли из файла и патч их не писал.
  // Строки, которые патч заменяет, для этого не годятся — их писал он же, и на
  // хунке, где заменяется весь кусок, они дали бы ответ патча, а не файла.
  // Если контекста в хунке нет вовсе, спрашиваем файл целиком.
  const ending = matchFileEndings ? endingOf(contextLines()) ?? endingOf(lines) : null;

  function contextLines(): string[] {
    const context: string[] = [];
    let probe = at;

    for (const line of hunk.lines) {
      const prefix = line.charAt(0);
      if (prefix === insertPrefix) continue;
      if (prefix !== removePrefix && lines[probe] !== undefined) context.push(lines[probe]);
      probe++;
    }

    return context;
  }

  for (const line of hunk.lines) {
    const prefix = line.charAt(0);
    if (prefix === insertPrefix) {
      out.push(withEnding(line.slice(1), ending));
      continue;
    }
    if (prefix === removePrefix) {
      index++;
      continue;
    }
    out.push(lines[index] ?? withEnding(line.slice(1), ending));
    index++;
  }

  return out;
}

export function applyHunks(
  original: string[],
  endsWithNewline: boolean,
  hunks: Hunk[],
  reverse: boolean,
  // Расходящийся поиск нужен при применении: файл мог сдвинуться. Выключается
  // он только там, где место обязано совпасть точно.
  search = true,
  // Приводить ли строки, взятые из патча, к переводу строки самого файла.
  //
  // Включает это только откат. Там патч — единственный источник удалённых строк,
  // а его переводы строк нормализуют по дороге и git, и веб-интерфейс GitHub: на
  // корпусе из 288 откатов четыре возвращали файл не байт в байт — три теряли
  // `\r` (у pixi-tilemap сразу 162 штуки), а один, наоборот, приносил `\r` в
  // файл, где их не было вовсе, потому что сам патч был в CRLF.
  //
  // Прямое применение так делать не должно: patch-package кладёт строку из
  // патча как есть, и на этом держится побайтовое совпадение деревьев.
  matchFileEndings = false,
): AppliedFile | {error: string} {
  let lines = original;
  let offset = 0;
  let trailing = endsWithNewline;
  let displacement = 0;

  for (const [index, hunk] of hunks.entries()) {
    const from = sideLines(hunk, reverse ? 'new' : 'old');
    const declared = (reverse ? hunk.newStart : hunk.oldStart) - 1;

    // Где хунк ждут: объявленное место плюс то, на сколько предыдущие хунки уже
    // сдвинули файл. Отсюда же считается смещение, так что число обязано быть
    // одним и тем же — посчитанное дважды, оно бы разъехалось молча.
    const preferred = Math.max(0, declared + offset);

    const at = locateHunk(lines, from, preferred, search);
    if (at === -1) {
      return {error: `hunk #${index + 1} does not fit (expected at line ${declared + 1})`};
    }

    displacement += Math.abs(at - preferred);

    const reachedEnd = at + from.length === lines.length;
    const replacement = buildReplacement(hunk, lines, at, reverse, matchFileEndings);
    lines = [...lines.slice(0, at), ...replacement, ...lines.slice(at + from.length)];
    offset += replacement.length - from.length;

    if (reachedEnd) {
      // Состояние перевода строки в конце меняем только по явному маркеру.
      // Раньше мы выставляли его всегда, когда хунк доставал до конца файла, —
      // и дописывали перевод строки файлу, у которого его отродясь не было,
      // хотя патч про это ничего не говорил.
      const missingAfter = reverse ? hunk.oldNoNewline : hunk.newNoNewline;
      const missingBefore = reverse ? hunk.newNoNewline : hunk.oldNoNewline;
      if (missingAfter) trailing = false;
      else if (missingBefore) trailing = true;
    }
  }

  return {lines, endsWithNewline: trailing, displacement};
}

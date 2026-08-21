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
export function linesEqual(a: string, b: string): boolean {
  return a === b || a.replace(/\s+$/, '') === b.replace(/\s+$/, '');
}

export function locateHunk(lines: string[], needle: string[], preferred: number, search = true): number {
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

// Строки контекста берём из файла, а не из патча. Патч намерен изменить только
// строки с + и -, а контекст он лишь описывает — и описывает неточно, если по
// дороге у него срезали хвостовые пробелы. Раньше диапазон пересобирался целиком
// из «новой стороны», и такие расхождения уехали бы в файл.
export function buildReplacement(hunk: Hunk, lines: string[], at: number, reverse: boolean): string[] {
  const removePrefix = reverse ? '+' : '-';
  const insertPrefix = reverse ? '-' : '+';
  const out: string[] = [];
  let index = at;

  for (const line of hunk.lines) {
    const prefix = line.charAt(0);
    if (prefix === insertPrefix) {
      out.push(line.slice(1));
      continue;
    }
    if (prefix === removePrefix) {
      index++;
      continue;
    }
    out.push(lines[index] ?? line.slice(1));
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
): AppliedFile | {error: string} {
  let lines = original;
  let offset = 0;
  let trailing = endsWithNewline;
  let displacement = 0;

  for (const [index, hunk] of hunks.entries()) {
    const from = sideLines(hunk, reverse ? 'new' : 'old');
    const declared = (reverse ? hunk.newStart : hunk.oldStart) - 1;

    const at = locateHunk(lines, from, Math.max(0, declared + offset), search);
    if (at === -1) {
      return {error: `hunk #${index + 1} does not fit (expected at line ${declared + 1})`};
    }

    displacement += Math.abs(at - Math.max(0, declared + offset));

    const reachedEnd = at + from.length === lines.length;
    const replacement = buildReplacement(hunk, lines, at, reverse);
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

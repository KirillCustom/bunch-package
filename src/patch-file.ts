import {existsSync, readdirSync} from 'fs';
import {PATCHES_DIR} from './paths';

export interface Hunk {
  oldStart: number;
  newStart: number;
  lines: string[]; // с префиксами ' ', '+', '-'
  oldNoNewline: boolean;
  newNoNewline: boolean;
}

export interface PatchTarget {
  oldPath: string | null; // null — это /dev/null, то есть файл создаётся
  newPath: string | null; // null — файл удаляется
  hunks: Hunk[];
  oldMode: string | null; // '100644' / '100755' из git-заголовков
  newMode: string | null;
  // `new file mode` и `deleted file mode` — это не смена прав, а появление или
  // исчезновение файла. Без хунков они означают пустой файл: именно так git
  // записывает создание пустышки, и такие секции встречаются в реальных патчах.
  newFile: boolean;
  deletedFile: boolean;
  // git пишет `rename from` / `rename to` уже без префиксов a/ и b/ —
  // это пути от корня проекта, срезать у них первый компонент не нужно.
  renameFrom: string | null;
  renameTo: string | null;
}

export function parsePatch(patchContent: string): PatchTarget[] {
  const targets: PatchTarget[] = [];
  let target: PatchTarget | null = null;
  let hunk: Hunk | null = null;
  let oldLeft = 0;
  let newLeft = 0;
  let lastPrefix = '';
  // Секция закрывается первым же хунком: дальше `---` или `diff --git` начинают
  // следующий файл, а не дополняют текущий.
  let open = false;

  const asPath = (raw: string): string | null => (raw === '/dev/null' ? null : raw);

  // Секцию заводим через параметр, а не через изменяемую переменную из
  // замыкания: TypeScript не отслеживает присваивания внутри замыканий и считал
  // бы target вечно нулевым, теряя проверку типов там, где она нужнее всего.
  const ensureTarget = (existing: PatchTarget | null): PatchTarget => {
    if (open && existing !== null) return existing;

    const fresh: PatchTarget = {
      oldPath: null,
      newPath: null,
      hunks: [],
      oldMode: null,
      newMode: null,
      newFile: false,
      deletedFile: false,
      renameFrom: null,
      renameTo: null,
    };
    targets.push(fresh);
    open = true;
    hunk = null;
    return fresh;
  };

  for (const raw of patchContent.split('\n')) {
    // Патч может быть в CRLF, а файл — в LF. Структурные строки чистим от \r,
    // иначе он уезжает в путь из заголовка: файла с таким именем нет, и патч
    // «не ложится». В выводе \r возвращал курсор в начало строки, поэтому путь
    // в сообщении об ошибке выглядел пустым. Тело хунка не трогаем — там \r
    // может быть частью содержимого файла.
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;

    // `\ No newline at end of file` относится к предыдущей строке и может стоять
    // как внутри тела, так и сразу за ним — счётчики к этому моменту исчерпаны.
    if (line.startsWith('\\')) {
      if (hunk) {
        if (lastPrefix === '-') hunk.oldNoNewline = true;
        else if (lastPrefix === '+') hunk.newNoNewline = true;
        else {
          hunk.oldNoNewline = true;
          hunk.newNoNewline = true;
        }
      }
      continue;
    }

    if (hunk && (oldLeft > 0 || newLeft > 0)) {
      hunk.lines.push(raw);
      lastPrefix = raw.charAt(0);
      if (lastPrefix === '-') oldLeft--;
      else if (lastPrefix === '+') newLeft--;
      else {
        oldLeft--;
        newLeft--;
        lastPrefix = ' ';
      }
      continue;
    }

    // Секция со сменой одного лишь режима не содержит ---/+++ вовсе, поэтому
    // пути приходится брать отсюда. Заодно это то, что печатает git.
    const gitHeader = line.match(/^diff --git (\S+) (\S+)$/);
    if (gitHeader) {
      // `diff --git` начинает секцию всегда, даже если предыдущая ещё открыта:
      // просить нечего, поэтому и существующей секции здесь не передаём. Раньше
      // это делалось сбросом `open` снаружи — то есть признак «секция открыта»
      // жил в двух местах сразу.
      const fresh = (target = ensureTarget(null));
      fresh.oldPath = gitHeader[1];
      fresh.newPath = gitHeader[2];
      continue;
    }

    // Режимы приходят git-заголовками. patch-package читает ровно эти строки,
    // поэтому формат патча остаётся с ним совместимым.
    const renameLine = line.match(/^rename (from|to) (.+)$/);
    if (renameLine) {
      const current = (target = ensureTarget(target));
      if (renameLine[1] === 'from') current.renameFrom = renameLine[2];
      else current.renameTo = renameLine[2];
      continue;
    }

    const modeLine = line.match(/^(old|new|new file|deleted file) mode (\d+)$/);
    if (modeLine) {
      const current = (target = ensureTarget(target));
      if (modeLine[1] === 'deleted file') {
        current.oldMode = modeLine[2];
        current.deletedFile = true;
      } else if (modeLine[1] === 'old') {
        current.oldMode = modeLine[2];
      } else {
        current.newMode = modeLine[2];
        if (modeLine[1] === 'new file') current.newFile = true;
      }
      continue;
    }

    const head = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (head && target !== null) {
      oldLeft = head[2] === undefined ? 1 : Number(head[2]);
      newLeft = head[4] === undefined ? 1 : Number(head[4]);
      hunk = {
        oldStart: Number(head[1]),
        newStart: Number(head[3]),
        lines: [],
        oldNoNewline: false,
        newNoNewline: false,
      };
      target.hunks.push(hunk);
      open = false;
      continue;
    }

    const oldHeader = line.match(/^--- ([^\t]+)/);
    if (oldHeader) {
      const current = (target = ensureTarget(target));
      current.oldPath = asPath(oldHeader[1]);
      continue;
    }

    const newHeader = line.match(/^\+\+\+ ([^\t]+)/);
    if (newHeader && target !== null) {
      target.newPath = asPath(newHeader[1]);
      continue;
    }
  }

  // Секция без хунков осмысленна, если несёт смену режима.
  return targets.filter(
    t => t.hunks.length > 0 || t.newMode !== null || t.oldMode !== null || t.renameTo !== null,
  );
}

// Откат патча — это применение перевёрнутого патча, а не отдельный применятель.
// Так весь разбор случаев (создание, удаление, переименование, режимы, файл без
// перевода строки в конце) остаётся один на оба направления — тот самый, что
// выверен корпусом. Второй экземпляр той же логики разошёлся бы с первым.
export function invertTarget(target: PatchTarget): PatchTarget {
  // Встречаются патчи, у которых стороны названы разными файлами без заголовков
  // rename: так выглядит `diff bootstrap.js.bak bootstrap.js`. Правят они всё
  // равно один файл — тот, что назван новой стороной, потому что именно его
  // берёт planTarget. Перестановка путей увела бы откат в файл, которого нет:
  // на корпусе это ровно тот случай, где дерево не возвращалось к эталону.
  const oneFile = target.renameFrom === null && target.oldPath !== null && target.newPath !== null;

  return {
    oldPath: target.newPath,
    newPath: oneFile ? target.newPath : target.oldPath,
    hunks: target.hunks.map(invertHunk),
    oldMode: target.newMode,
    newMode: target.oldMode,
    // `new file mode` наоборот означает, что файл исчезает, и обратно.
    newFile: target.deletedFile,
    deletedFile: target.newFile,
    renameFrom: target.renameTo,
    renameTo: target.renameFrom,
  };
}

function invertHunk(hunk: Hunk): Hunk {
  return {
    oldStart: hunk.newStart,
    newStart: hunk.oldStart,
    lines: hunk.lines.map(line => {
      const prefix = line.charAt(0);
      if (prefix === '+') return `-${line.slice(1)}`;
      if (prefix === '-') return `+${line.slice(1)}`;
      return line; // контекст остаётся контекстом
    }),
    oldNoNewline: hunk.newNoNewline,
    newNoNewline: hunk.oldNoNewline,
  };
}

// Одна сторона хунка: для старой отбрасываем добавленные строки, для новой — удалённые.
// Пустая строка — это контекст, у которого срезали хвостовой пробел.
export function sideLines(hunk: Hunk, side: 'old' | 'new'): string[] {
  const drop = side === 'old' ? '+' : '-';
  return hunk.lines.filter(line => !line.startsWith(drop)).map(line => line.slice(1));
}

// Пуста ли сторона — спрашивают чаще, чем строят саму сторону: пустая старая
// означает создание файла, пустая новая — удаление. Спрашивать это через
// sideLines(...).length значит собрать список строк ради того, чтобы узнать,
// что он пуст.
export function sideIsEmpty(hunk: Hunk, side: 'old' | 'new'): boolean {
  const drop = side === 'old' ? '+' : '-';
  return hunk.lines.every(line => line.startsWith(drop));
}

// Имя файла патча несёт пакет, версию и — для последовательности — номер и
// метку: `react-native+0.72.0+002+fix-touchable.patch`. Такой формат у
// patch-package, и повторять его стоит: патчи людей и инструментов ходят
// между проектами.
//
// Версия сама может содержать `+` (метаданные сборки), поэтому разбираем справа:
// номер — ровно три цифры, метка без `+`, остальное слева — пакет и версия.
export interface PatchName {
  packageDir: string; // как каталог в node_modules, со слэшем для скоупа
  version: string;
  sequence: number; // 0 — одиночный патч вне последовательности
  label: string;
}

export function parsePatchName(file: string): PatchName | null {
  if (!file.endsWith('.patch')) return null;
  const base = file.slice(0, -'.patch'.length);

  const sequenced = base.match(/^(.+)\+(\d{3})\+([^+]+)$/);
  const head = sequenced ? sequenced[1] : base;
  const separator = head.lastIndexOf('+');
  if (separator === -1) return null;

  return {
    packageDir: head.slice(0, separator).replace(/\+/g, '/'),
    version: head.slice(separator + 1),
    sequence: sequenced ? Number(sequenced[2]) : 0,
    label: sequenced ? sequenced[3] : '',
  };
}

// Обратная к parsePatchName: формат имени описан выше, и собирать его руками в
// каждой команде значило бы держать разбор и сборку в разных файлах — они бы
// разъехались молча, а признаком стал бы патч, которого никто больше не узнаёт.
export function formatPatchName(parts: {packageDir: string; version: string; sequence?: number; label?: string}): string {
  const head = `${parts.packageDir.replace(/\//g, '+')}+${parts.version}`;
  if (!parts.sequence || parts.label === undefined || parts.label === '') return `${head}.patch`;
  return `${head}+${String(parts.sequence).padStart(3, '0')}+${parts.label}.patch`;
}

// Все команды перечисляют patches/ одинаково, и все обязаны получить один и тот
// же порядок: патчи последовательности строятся друг на друге. Отсутствующий
// каталог — это просто пустой список; что о нём сказать, решает вызывающий.
export function listPatchFiles(): string[] {
  if (!existsSync(PATCHES_DIR)) return [];
  return orderPatchFiles(readdirSync(PATCHES_DIR).filter(file => file.endsWith('.patch')));
}

// Патчи одной последовательности строятся друг на друге, как коммиты, поэтому
// порядок обязан быть детерминированным. readdirSync его не даёт: он вернул
// файлы в порядке создания, а не по имени.
export function orderPatchFiles(files: string[]): string[] {
  return [...files].sort((a, b) => {
    const left = parsePatchName(a);
    const right = parsePatchName(b);
    if (left && right && left.packageDir === right.packageDir && left.version === right.version) {
      return left.sequence - right.sequence;
    }
    return a.localeCompare(b);
  });
}

// Ниже — собственное применение унифицированных диффов. Раньше эту работу делал
// системный patch(1), и половина проблем росла именно оттуда: на Linux это GNU,
// на macOS — Apple, у них расходятся коды возврата, тексты сообщений и даже
// защита от выхода за корень проекта. Плюс patch применяет файлы по одному,
// поэтому провал на середине оставлял дерево наполовину пропатченным и сыпал
// .rej/.orig. Здесь ничего не пишется на диск, пока не сойдётся весь патч.

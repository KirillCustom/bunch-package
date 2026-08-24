// Разбор аргументов у нас свой и строгий: неизвестный флаг — отказ, а не
// молчаливое «не понял». Молчание тут особенно дорого: `--exclude` с опечаткой
// в имени флага означал бы патч, в который уехало лишнее, и заметили бы это
// через неделю.
export interface Options {
  packages: string[];
  append: string | null;
  patchDir: string | null;
  include: string | null;
  exclude: string | null;
  caseSensitive: boolean;
  errorOnWarn: boolean;
  dev: boolean;
}

const WITH_VALUE = new Set(['--append', '--patch-dir', '--include', '--exclude']);
const WITHOUT_VALUE = new Set(['--case-sensitive-path-filtering', '--error-on-warn', '--dev']);

export function parseOptions(argv: string[]): Options {
  const options: Options = {
    packages: [],
    append: null,
    patchDir: null,
    include: null,
    exclude: null,
    caseSensitive: false,
    errorOnWarn: false,
    dev: false,
  };

  for (let at = 0; at < argv.length; at++) {
    const argument = argv[at];

    if (!argument.startsWith('--')) {
      options.packages.push(argument);
      continue;
    }

    // Обе формы: `--patch-dir dir` и `--patch-dir=dir`.
    const equals = argument.indexOf('=');
    const flag = equals === -1 ? argument : argument.slice(0, equals);
    const inline = equals === -1 ? null : argument.slice(equals + 1);

    if (WITHOUT_VALUE.has(flag)) {
      if (inline !== null) throw new Error(`${flag} takes no value`);
      if (flag === '--case-sensitive-path-filtering') options.caseSensitive = true;
      else if (flag === '--error-on-warn') options.errorOnWarn = true;
      else options.dev = true;
      continue;
    }

    if (!WITH_VALUE.has(flag)) throw new Error(`Unknown option: ${flag}`);

    const value = inline ?? argv[++at];
    if (value === undefined || value === '') throw new Error(`${flag} needs a value`);

    if (flag === '--append') options.append = validLabel(value);
    else if (flag === '--patch-dir') options.patchDir = value;
    else if (flag === '--include') options.include = validRegExp(flag, value);
    else options.exclude = validRegExp(flag, value);
  }

  return options;
}

// Метка попадает в имя файла, поэтому в ней только то, что имя выдержит.
function validLabel(label: string): string {
  if (!/^[\w.-]+$/.test(label)) {
    throw new Error('--append needs a name made of letters, digits, dots, dashes or underscores');
  }
  return label;
}

// Битую регулярку ловим при разборе, а не посреди работы: до этого места
// команда уже успела бы скачать эталон.
function validRegExp(flag: string, pattern: string): string {
  try {
    new RegExp(pattern);
  } catch (error: any) {
    throw new Error(`${flag} is not a valid regular expression: ${error.message}`);
  }
  return pattern;
}

// Фильтры путей — как у patch-package: сравниваются с путём от корня пакета,
// по умолчанию берётся всё, и по умолчанию регистр не различается.
export interface PathFilters {
  include: RegExp | null;
  exclude: RegExp | null;
}

export function filtersOf(options: Options): PathFilters {
  const flags = options.caseSensitive ? '' : 'i';
  return {
    include: options.include === null ? null : new RegExp(options.include, flags),
    exclude: options.exclude === null ? null : new RegExp(options.exclude, flags),
  };
}

export function pathAllowed(relativePath: string, filters: PathFilters): boolean {
  if (filters.include !== null && !filters.include.test(relativePath)) return false;
  return filters.exclude === null || !filters.exclude.test(relativePath);
}

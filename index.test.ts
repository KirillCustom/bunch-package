import {describe, test, expect, beforeEach, afterEach, setDefaultTimeout} from 'bun:test';
import {execSync, spawn, spawnSync} from 'child_process';
import {createHash} from 'crypto';
import {chmodSync, cpSync, existsSync, linkSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, statSync, symlinkSync, writeFileSync, rmSync, unlinkSync} from 'fs';
import {findLinkDifferences, runDiff, scanTree, withPristine} from './src/create';
import {parseOptions} from './src/options';
import {parseRepository} from './src/upstream';
import {withApplyLock} from './src/lock';
import {ensureDir} from './src/paths';
import {invertTarget, orderPatchFiles, parsePatch} from './src/patch-file';
import {join} from 'path';

// writeFileSync пишет в тот же inode, что ломает тесты при hardlink-кеше bun.
// Удаляем файл перед записью, чтобы разорвать hardlink.
function overwriteFile(path: string, content: string) {
  if (existsSync(path)) unlinkSync(path);
  writeFileSync(path, content);
}

// Дерево целиком одним числом: имя, содержимое, порядок. Нужен там, где
// проверяется, что каталога не касались вовсе.
function hashTree(root: string): string {
  const hash = createHash('sha256');

  const walk = (dir: string, prefix: string) => {
    for (const entry of readdirSync(dir, {withFileTypes: true}).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = join(dir, entry.name);
      const relative = prefix + entry.name;
      if (entry.isDirectory()) {
        walk(full, `${relative}/`);
      } else if (entry.isFile()) {
        hash.update(`F ${relative} `);
        hash.update(readFileSync(full));
      } else {
        hash.update(`? ${relative}`);
      }
      hash.update('\n');
    }
  };

  walk(root, '');
  return hash.digest('hex');
}

// Часть тестов ставит реальный пакет из реестра, а дефолтные 5 секунд bun'а
// упираются в сеть, а не в код. Тайм-аут поднят, чтобы падения означали дефект.
setDefaultTimeout(120_000);

// Песочница у каждого процесса своя. Один общий каталог означал, что два
// прогона сюиты затаптывают друг друга: beforeEach одного сносит дерево, с
// которым работает другой. Измерено на этом коде — 26 и 27 падений из 59, и
// однажды день ушёл на разбор девяти «дефектов», которых не было.
const TEST_DIR = join(import.meta.dir, `.test-sandbox-${process.pid}`);
const CLI = join(import.meta.dir, 'index.ts');

// Запускаем ровно тот bun, что исполняет сам набор тестов, а не первый по PATH:
// иначе тест, подменяющий PATH, подменял бы заодно и запускающий процесс.
function run(args: string, cwd: string, env?: Record<string, string>): {stdout: string; exitCode: number} {
  try {
    const stdout = execSync(`"${process.execPath}" "${CLI}" ${args}`, {
      cwd,
      encoding: 'utf-8',
      stdio: 'pipe',
      env: env ? {...process.env, ...env} : process.env,
    });
    return {stdout, exitCode: 0};
  } catch (error: any) {
    return {stdout: (error.stdout || '') + (error.stderr || ''), exitCode: error.status ?? 1};
  }
}

// На Windows бита исполнения нет: NTFS его не хранит, chmod почти no-op, а
// statSync возвращает одинаковый режим всем файлам. Проверять там нечего —
// и сам инструмент это переживает: create не находит несуществующих различий,
// а apply просто не может выставить режим, которого в системе не бывает.
const isWindows = process.platform === 'win32';

function isExecutable(path: string): boolean {
  return (statSync(path).mode & 0o111) !== 0;
}

function setupFakePackage(dir: string, name: string, version: string, files: Record<string, string>) {
  const pkgDir = join(dir, 'node_modules', name);
  mkdirSync(pkgDir, {recursive: true});
  writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({name, version}));
  for (const [file, content] of Object.entries(files)) {
    const filePath = join(pkgDir, file);
    mkdirSync(join(filePath, '..'), {recursive: true});
    writeFileSync(filePath, content);
  }
}

function removeTestDir() {
  if (!existsSync(TEST_DIR)) return;
  rmSync(TEST_DIR, {force: true, recursive: true});
}

function initTestDir() {
  removeTestDir();
  mkdirSync(TEST_DIR, {recursive: true});
  writeFileSync(join(TEST_DIR, 'package.json'), JSON.stringify({name: 'test-project', version: '1.0.0'}));
}

beforeEach(() => {
  initTestDir();
});

afterEach(() => {
  removeTestDir();
});

describe('bunch-package create', () => {
  test('throws error when package not found', () => {
    mkdirSync(join(TEST_DIR, 'node_modules'), {recursive: true});
    const result = run('create nonexistent-pkg', TEST_DIR);
    expect(result.exitCode).not.toBe(0);
  });

  test('creates patch file when package is modified', () => {
    // Устанавливаем реальный маленький пакет и модифицируем его
    execSync('bun add is-number@7.0.0', {cwd: TEST_DIR, stdio: 'pipe'});
    const indexPath = join(TEST_DIR, 'node_modules', 'is-number', 'index.js');
    const original = readFileSync(indexPath, 'utf-8');
    overwriteFile(indexPath, original + '\n// patched by test');

    const result = run('create is-number', TEST_DIR);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Patch created');

    const patchPath = join(TEST_DIR, 'patches', 'is-number+7.0.0.patch');
    expect(existsSync(patchPath)).toBe(true);
  });

  test('patch contains relative paths, not absolute', () => {
    execSync('bun add is-number@7.0.0', {cwd: TEST_DIR, stdio: 'pipe'});
    const indexPath = join(TEST_DIR, 'node_modules', 'is-number', 'index.js');
    overwriteFile(indexPath, 'module.exports = "changed";');

    run('create is-number', TEST_DIR);

    const patchPath = join(TEST_DIR, 'patches', 'is-number+7.0.0.patch');
    const patchContent = readFileSync(patchPath, 'utf-8');

    expect(patchContent).toContain('a/node_modules/is-number');
    expect(patchContent).toContain('b/node_modules/is-number');
    expect(patchContent).not.toContain(TEST_DIR);
  });

  // Патч с `rename from/to` приезжает от git и patch-package — наш create такие
  // не выпускает, он строится на `diff -r`. Поэтому пока переименование не
  // воспроизводилось на эталоне, молчали и корпус, и сюита: эталон оставался со
  // старым именем файла, дерево — с новым, и разница между ними снова
  // выглядела как «удалить старый, добавить новый».
  test('replays a rename onto the pristine copy instead of repeating it', () => {
    execSync('bun add ms@2.1.2', {cwd: TEST_DIR, stdio: 'pipe'});
    mkdirSync(join(TEST_DIR, 'patches'), {recursive: true});
    writeFileSync(
      join(TEST_DIR, 'patches', 'ms+2.1.2+001+one.patch'),
      `diff --git a/node_modules/ms/index.js b/node_modules/ms/renamed.js
similarity index 100%
rename from node_modules/ms/index.js
rename to node_modules/ms/renamed.js
`,
    );
    expect(run('apply', TEST_DIR).exitCode).toBe(0);

    const renamed = join(TEST_DIR, 'node_modules', 'ms', 'renamed.js');
    overwriteFile(renamed, readFileSync(renamed, 'utf-8') + '\n// SECOND\n');

    expect(run('create ms --append second', TEST_DIR).exitCode).toBe(0);

    const second = readFileSync(join(TEST_DIR, 'patches', 'ms+2.1.2+002+second.patch'), 'utf-8');
    expect(second).toContain('+// SECOND');
    // Второй патч несёт только свою правку: ни удаления index.js, ни всего
    // renamed.js заново.
    expect(second).not.toContain('index.js');
    expect(second.split('\n').length).toBeLessThan(20);
  });

  // Эталон стоит скачивания, и раньше оно повторялось на каждый запуск: кеш
  // лежал внутри временного каталога, а тот убирается в finally. Измерено на
  // typescript@5.4.5 (31 МБ): 8–10 с на каждый create против 0,6 с, когда кеш
  // пережил прогон.
  // Не на Windows: установщик здесь убивается нашим таймаутом, а его потомки
  // переживают убийство и держат файлы временного каталога — система не отдаёт
  // их и через секунду повторов, поэтому песочницу не может снести уже сама
  // сюита, и падает не этот тест, а шесть следующих (измерено в CI дважды).
  // Тот же класс отказа на Windows закрыт соседним тестом, который получает
  // ответ реестра, ничего не обрывая.
  test.skipIf(isWindows)('names why the pristine copy could not be fetched, instead of printing progress', () => {
    // Первая строка чужого вывода — это ход работы, а не отказ: на недоступном
    // реестре bun печатает `Resolving dependencies`, и раньше именно она уезжала
    // в наш отчёт. Второй по частоте класс жалоб на patch-package — ровно такой
    // невнятный отказ (NOT-24), и «говорить вслух» — заявленная сильная сторона.
    setupFakePackage(TEST_DIR, 'test-lib', '1.0.0', {'index.js': 'const a = 1;\n'});

    const result = run('create test-lib', TEST_DIR, {
      BUN_CONFIG_REGISTRY: 'http://127.0.0.1:9/',
      npm_config_registry: 'http://127.0.0.1:9/',
      BUNCH_FETCH_TIMEOUT: '5',
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toContain('Could not fetch a pristine test-lib@1.0.0');
    expect(result.stdout).toMatch(/bun: .*error/i);
    expect(result.stdout).not.toContain('Resolving dependencies');
  });

  test('passes on what the registry said, for both ways of fetching', () => {
    // Запасной путь через npm мы просили молчать флагом `--silent`, и он молчал
    // ровно тогда, когда сказать было что: в отчёте оставалось «Command failed:
    // npm pack …» — команда вместо причины. Здесь спрашивается пакет, которого
    // в реестре нет, и обе строки отчёта обязаны нести ответ реестра.
    setupFakePackage(TEST_DIR, 'bunch-package-no-such-thing-4f1c2a', '9.9.9', {'index.js': 'const a = 1;\n'});

    const result = run('create bunch-package-no-such-thing-4f1c2a', TEST_DIR);

    expect(result.exitCode).not.toBe(0);
    // Строка обязана называть пакет, а не только код: `npm error code E404`
    // человеку не говорит ни что искали, ни где.
    expect(result.stdout).toMatch(/bun: .*bunch-package-no-such-thing-4f1c2a.*404/);
    expect(result.stdout).toMatch(/npm: .*bunch-package-no-such-thing-4f1c2a/);
    expect(result.stdout).not.toContain('Command failed');
  });

  test.skipIf(isWindows)('a failing cleanup does not swallow the reason', () => {
    // Уборка временного каталога живёт в finally, и её собственный отказ
    // перебивал причину, с которой всё началось. На Windows это поймал CI:
    // установщик, убитый нашим таймаутом, ещё держал файлы, и человек вместо
    // «Could not fetch a pristine …» получал «EBUSY: resource busy or locked».
    //
    // Здесь тот же сбой уборки строится правами: каталог, из которого удаляют,
    // становится нередактируемым. На Windows прав в этом смысле нет, поэтому
    // там за это отвечает сам сценарий с таймаутом.
    const previous = process.cwd();
    process.chdir(TEST_DIR);

    try {
      expect(() =>
        withPristine('ms', '2.1.2', () => {
          chmodSync(TEST_DIR, 0o555); // удалить временный каталог теперь нельзя
          throw new Error('the reason we came here');
        }),
      ).toThrow('the reason we came here');
    } finally {
      chmodSync(TEST_DIR, 0o755);
      process.chdir(previous);
    }
  });

  test('keeps its pristine cache outside the run', () => {
    const cache = join(TEST_DIR, 'pristine-cache');
    execSync('bun add is-number@7.0.0', {cwd: TEST_DIR, stdio: 'pipe'});
    const indexPath = join(TEST_DIR, 'node_modules', 'is-number', 'index.js');
    overwriteFile(indexPath, readFileSync(indexPath, 'utf-8') + '\n// patched\n');

    const result = run('create is-number', TEST_DIR, {BUNCH_PRISTINE_CACHE: cache});

    expect(result.exitCode).toBe(0);
    expect(existsSync(cache)).toBe(true);
    expect(readdirSync(cache).length).toBeGreaterThan(0);
  });

  // В эталон мы пишем: им доводятся предыдущие патчи последовательности. Пойди
  // такая запись «на месте», а bun разложи эталон hardlink'ами (на Linux это
  // умолчание) — она изменила бы сам кеш, и следующая «чистая» установка
  // приехала бы уже пропатченной, а diff ответил бы «No changes detected».
  // Инвариант: после доводки кеш обязан быть тем же байт в байт.
  test('never writes into the pristine cache while replaying patches', () => {
    const cache = join(TEST_DIR, 'pristine-cache');
    execSync('bun add ms@2.1.2', {cwd: TEST_DIR, stdio: 'pipe'});
    const file = join(TEST_DIR, 'node_modules', 'ms', 'index.js');
    overwriteFile(file, `// FIRST\n${readFileSync(file, 'utf-8')}`);
    expect(run('create ms', TEST_DIR, {BUNCH_PRISTINE_CACHE: cache}).exitCode).toBe(0);

    const before = hashTree(cache);

    overwriteFile(file, readFileSync(file, 'utf-8') + '\n// SECOND\n');
    expect(run('create ms --append second', TEST_DIR, {BUNCH_PRISTINE_CACHE: cache}).exitCode).toBe(0);

    expect(hashTree(cache)).toBe(before);
  });

  test('refuses a non-UTF-8 file instead of writing a corrupt patch', () => {
    execSync('bun add is-number@7.0.0', {cwd: TEST_DIR, stdio: 'pipe'});
    // latin-1 без нулевых байтов diff считает текстом и печатает как есть —
    // раньше эти байты превращались в U+FFFD и патч уезжал испорченным.
    writeFileSync(
      join(TEST_DIR, 'node_modules', 'is-number', 'latin.js'),
      Buffer.from([0x2f, 0x2f, 0x20, 0xe9, 0xe8, 0xfc, 0x0a]),
    );

    const result = run('create is-number', TEST_DIR);
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toContain('not valid UTF-8');
    expect(existsSync(join(TEST_DIR, 'patches', 'is-number+7.0.0.patch'))).toBe(false);
  });

  // На Windows урезать PATH до одного каталога рискованно: bun может не найти
  // системные библиотеки. Проверка при этом платформонезависима.
  test.skipIf(isWindows)('fails fast and clearly when diff is missing', () => {
    execSync('bun add is-number@7.0.0', {cwd: TEST_DIR, stdio: 'pipe'});
    const indexPath = join(TEST_DIR, 'node_modules', 'is-number', 'index.js');
    overwriteFile(indexPath, readFileSync(indexPath, 'utf-8') + '\n// changed\n');

    // PATH оставляем ровно с каталогом, где лежит bun: сам он запустится, а diff
    // из /usr/bin — уже нет. Каталог берём у оболочки: process.execPath ведёт на
    // сам бинарник, а запускается bun через обёртку, лежащую в другом месте.
    const bunDir = join(execSync('command -v bun', {encoding: 'utf-8'}).trim(), '..');
    const result = run('create is-number', TEST_DIR, {PATH: bunDir});

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toContain('needs the `diff` command');
    // Отказ должен случиться до скачивания эталона.
    expect(result.stdout).not.toContain('Fetching pristine');
    expect(existsSync(join(TEST_DIR, 'patches'))).toBe(false);
  });

  test('reports both failures when the pristine copy cannot be fetched', () => {
    // Запасной путь через npm вызывал firstDiagnosticLine, а та функция была
    // потеряна при рефакторинге — вместо отката летел ReferenceError. Путь
    // исполняется только при сбое bun add, поэтому ни один тест его не задевал.
    mkdirSync(join(TEST_DIR, 'node_modules', 'ghostpkg'), {recursive: true});
    writeFileSync(join(TEST_DIR, 'node_modules', 'ghostpkg', 'package.json'),
      JSON.stringify({name: 'ghostpkg', version: '9.9.9-does-not-exist'}));
    writeFileSync(join(TEST_DIR, 'node_modules', 'ghostpkg', 'index.js'), 'x\n');

    const result = run('create ghostpkg', TEST_DIR);
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toContain('Could not fetch a pristine');
    expect(result.stdout).toContain('bun:');
    expect(result.stdout).toContain('npm:');
    expect(result.stdout).not.toContain('ReferenceError');
  });

  test('refuses a package name of ..', () => {
    mkdirSync(join(TEST_DIR, 'node_modules'), {recursive: true});
    const result = run('create ..', TEST_DIR);
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toContain('Invalid package name');
  });

  test.skipIf(isWindows)('captures a change of the executable bit alone', () => {
    execSync('bun add is-number@7.0.0', {cwd: TEST_DIR, stdio: 'pipe'});
    const indexPath = join(TEST_DIR, 'node_modules', 'is-number', 'index.js');
    // На Linux bun раскладывает пакеты hardlink'ами, и chmod правит тот же инод,
    // что лежит в общем кеше. Разрываем связь тем же содержимым, иначе тест
    // испортит режим в кеше и следующий тест увидит «изменённый» пакет.
    overwriteFile(indexPath, readFileSync(indexPath, 'utf-8'));
    chmodSync(indexPath, 0o755);

    const result = run('create is-number', TEST_DIR);
    expect(result.stdout).not.toContain('No changes detected');
    expect(result.stdout).toContain('executable bit');

    // git-заголовки: ровно те строки, которые читает patch-package.
    const patchContent = readFileSync(join(TEST_DIR, 'patches', 'is-number+7.0.0.patch'), 'utf-8');
    expect(patchContent).toContain('old mode 100644');
    expect(patchContent).toContain('new mode 100755');

    chmodSync(indexPath, 0o644);
    const applied = run('apply', TEST_DIR);
    expect(applied.stdout).toContain('1 applied, 0 failed');
    expect(isExecutable(indexPath)).toBe(true);

    const again = run('apply', TEST_DIR);
    expect(again.stdout).toContain('already applied');
    expect(again.exitCode).toBe(0);
  });

  test('--append starts a sequence and records only the new change', () => {
    execSync('bun add is-number@7.0.0', {cwd: TEST_DIR, stdio: 'pipe'});
    const indexPath = join(TEST_DIR, 'node_modules', 'is-number', 'index.js');

    overwriteFile(indexPath, readFileSync(indexPath, 'utf-8') + '\n// first-change\n');
    run('create is-number', TEST_DIR);
    expect(existsSync(join(TEST_DIR, 'patches', 'is-number+7.0.0.patch'))).toBe(true);

    overwriteFile(indexPath, readFileSync(indexPath, 'utf-8') + '\n// second-change\n');
    const appended = run('create is-number --append second', TEST_DIR);
    expect(appended.exitCode).toBe(0);

    // Одиночный патч задним числом становится первым в последовательности.
    const patches = readdirSync(join(TEST_DIR, 'patches')).sort();
    expect(patches).toEqual(['is-number+7.0.0+001+initial.patch', 'is-number+7.0.0+002+second.patch']);

    // Второй патч отсчитывается от состояния после первого, а не от чистого
    // пакета — иначе он нёс бы в себе и первую правку.
    const second = readFileSync(join(TEST_DIR, 'patches', 'is-number+7.0.0+002+second.patch'), 'utf-8');
    // first-change попадает во второй патч строкой контекста — это нормально.
    // Важно, что он не добавляется заново.
    expect(second).toContain('+// second-change');
    expect(second).not.toContain('+// first-change');
  });

  test('create without --append updates the last patch of a sequence', () => {
    execSync('bun add is-number@7.0.0', {cwd: TEST_DIR, stdio: 'pipe'});
    const indexPath = join(TEST_DIR, 'node_modules', 'is-number', 'index.js');

    overwriteFile(indexPath, readFileSync(indexPath, 'utf-8') + '\n// first-change\n');
    run('create is-number', TEST_DIR);
    overwriteFile(indexPath, readFileSync(indexPath, 'utf-8') + '\n// second-change\n');
    run('create is-number --append second', TEST_DIR);

    overwriteFile(indexPath, readFileSync(indexPath, 'utf-8') + '\n// second-fixed\n');
    run('create is-number', TEST_DIR);

    const patches = readdirSync(join(TEST_DIR, 'patches')).sort();
    expect(patches).toEqual(['is-number+7.0.0+001+initial.patch', 'is-number+7.0.0+002+second.patch']);

    const first = readFileSync(join(TEST_DIR, 'patches', 'is-number+7.0.0+001+initial.patch'), 'utf-8');
    const second = readFileSync(join(TEST_DIR, 'patches', 'is-number+7.0.0+002+second.patch'), 'utf-8');
    expect(first).toContain('first-change');
    expect(first).not.toContain('second');
    expect(second).toContain('second-fixed');
  });

  test('reports no changes when package is not modified', () => {
    execSync('bun add is-number@7.0.0', {cwd: TEST_DIR, stdio: 'pipe'});

    const result = run('create is-number', TEST_DIR);
    expect(result.stdout).toContain('No changes detected');
  });

  test('picks up a change even when the shared bun cache is poisoned', () => {
    // bun раскладывает пакеты hardlink'ами: файл в node_modules и запись в кеше —
    // один инод, поэтому правка файла меняет кеш, и эталон приезжает изменённым.
    // Кеш держим внутри песочницы, чтобы не трогать настоящий кеш разработчика,
    // но отдаём его и CLI — иначе условие бага не воспроизводится.
    const cacheDir = join(TEST_DIR, 'bun-cache');
    const env = {BUN_INSTALL_CACHE_DIR: cacheDir};

    execSync('bun add --backend=hardlink is-number@7.0.0', {
      cwd: TEST_DIR,
      stdio: 'pipe',
      env: {...process.env, ...env},
    });

    const indexPath = join(TEST_DIR, 'node_modules', 'is-number', 'index.js');
    // Дописываем в тот же инод — именно так это делает обычный редактор.
    writeFileSync(indexPath, readFileSync(indexPath, 'utf-8') + '\n// poisoned-cache-marker\n');

    const result = run('create is-number', TEST_DIR, env);
    expect(result.stdout).not.toContain('No changes detected');
    expect(result.stdout).toContain('Patch created');

    const patchContent = readFileSync(join(TEST_DIR, 'patches', 'is-number+7.0.0.patch'), 'utf-8');
    expect(patchContent).toContain('poisoned-cache-marker');
  });

  test('keeps a root build/ directory but skips platform build artifacts', () => {
    execSync('bun add is-number@7.0.0', {cwd: TEST_DIR, stdio: 'pipe'});
    const pkgDir = join(TEST_DIR, 'node_modules', 'is-number');

    // У множества пакетов build/ в корне — это их распространяемый код.
    mkdirSync(join(pkgDir, 'build'), {recursive: true});
    writeFileSync(join(pkgDir, 'build', 'index.js'), 'exports.dist = 1;\n');

    // А под платформенным каталогом — артефакт сборки.
    mkdirSync(join(pkgDir, 'android', 'build'), {recursive: true});
    writeFileSync(join(pkgDir, 'android', 'build', 'artifact.txt'), 'build junk\n');
    mkdirSync(join(pkgDir, 'android', '.gradle'), {recursive: true});
    writeFileSync(join(pkgDir, 'android', '.gradle', 'cache.bin'), 'gradle junk\n');

    const result = run('create is-number', TEST_DIR);
    expect(result.stdout).toContain('Skipped 2 build-artifact path(s)');
    expect(result.stdout).toContain('android/build/artifact.txt');

    const patchContent = readFileSync(join(TEST_DIR, 'patches', 'is-number+7.0.0.patch'), 'utf-8');
    expect(patchContent).toContain('a/node_modules/is-number/build/index.js');
    expect(patchContent).not.toContain('android/build/artifact.txt');
    expect(patchContent).not.toContain('android/.gradle');
  });

  test('does not rewrite an absolute path that appears inside file content', () => {
    execSync('bun add is-number@7.0.0', {cwd: TEST_DIR, stdio: 'pipe'});
    const indexPath = join(TEST_DIR, 'node_modules', 'is-number', 'index.js');

    // Путь проекта, встретившийся в самом файле, не должен быть переписан:
    // раньше нормализация была заменой подстроки по всему тексту диффа.
    const line = `// cached at ${TEST_DIR}/node_modules/is-number\n`;
    overwriteFile(indexPath, readFileSync(indexPath, 'utf-8') + line);

    run('create is-number', TEST_DIR);

    const patchContent = readFileSync(join(TEST_DIR, 'patches', 'is-number+7.0.0.patch'), 'utf-8');
    expect(patchContent).toContain(`// cached at ${TEST_DIR}/node_modules/is-number`);
  });

  test('outputs hash and stats', () => {
    execSync('bun add is-number@7.0.0', {cwd: TEST_DIR, stdio: 'pipe'});
    const indexPath = join(TEST_DIR, 'node_modules', 'is-number', 'index.js');
    overwriteFile(indexPath, 'module.exports = "changed";');

    const result = run('create is-number', TEST_DIR);
    expect(result.stdout).toContain('Hash:');
    expect(result.stdout).toContain('Lines:');
    expect(result.stdout).toContain('Size:');
  });
});

describe('bunch-package apply', () => {
  test('reports no patches directory', () => {
    const result = run('apply', TEST_DIR);
    expect(result.stdout).toContain('No patches directory found');
  });

  test('reports no patches found', () => {
    mkdirSync(join(TEST_DIR, 'patches'), {recursive: true});
    const result = run('apply', TEST_DIR);
    expect(result.stdout).toContain('No patches found');
  });

  test('applies a patch created by create command', () => {
    // Устанавливаем пакет, модифицируем, создаём патч
    execSync('bun add is-number@7.0.0', {cwd: TEST_DIR, stdio: 'pipe'});
    const indexPath = join(TEST_DIR, 'node_modules', 'is-number', 'index.js');
    const original = readFileSync(indexPath, 'utf-8');
    overwriteFile(indexPath, original + '\n// bunch-test-marker');

    run('create is-number', TEST_DIR);

    // Восстанавливаем оригинал
    overwriteFile(indexPath, original);

    // Применяем патч
    const result = run('apply', TEST_DIR);
    expect(result.stdout).toContain('1 applied, 0 failed');

    // Проверяем что изменения применились
    const modified = readFileSync(indexPath, 'utf-8');
    expect(modified).toContain('// bunch-test-marker');
  });

  test('applies a sequence in order, whatever order the directory lists it in', () => {
    setupFakePackage(TEST_DIR, 'test-lib', '1.0.0', {
      'index.js': 'const a = 1;\n',
    });
    mkdirSync(join(TEST_DIR, 'patches'), {recursive: true});

    // Второй патч ложится только поверх первого. Записываем их в обратном
    // порядке: readdirSync отдаёт файлы в порядке создания, а не по имени,
    // поэтому без явной сортировки последовательность применилась бы вразнобой.
    writeFileSync(join(TEST_DIR, 'patches', 'test-lib+1.0.0+002+two.patch'), `--- a/node_modules/test-lib/index.js
+++ b/node_modules/test-lib/index.js
@@ -1 +1 @@
-const a = 2;
+const a = 3;
`);
    writeFileSync(join(TEST_DIR, 'patches', 'test-lib+1.0.0+001+one.patch'), `--- a/node_modules/test-lib/index.js
+++ b/node_modules/test-lib/index.js
@@ -1 +1 @@
-const a = 1;
+const a = 2;
`);

    const result = run('apply', TEST_DIR);
    expect(result.stdout).toContain('2 applied, 0 failed');
    expect(result.exitCode).toBe(0);
    expect(readFileSync(join(TEST_DIR, 'node_modules', 'test-lib', 'index.js'), 'utf-8')).toBe('const a = 3;\n');

    const again = run('apply', TEST_DIR);
    expect(again.exitCode).toBe(0);
  });

  test('warns on version mismatch', () => {
    setupFakePackage(TEST_DIR, 'test-lib', '2.0.0', {
      'index.js': 'const a = 1;',
    });

    mkdirSync(join(TEST_DIR, 'patches'), {recursive: true});
    const patchContent = `--- a/node_modules/test-lib/index.js\t2026-01-01 00:00:00
+++ b/node_modules/test-lib/index.js\t2026-01-01 00:00:00
@@ -1 +1 @@
-const a = 1;
+const a = 2;
`;
    writeFileSync(join(TEST_DIR, 'patches', 'test-lib+1.0.0.patch'), patchContent);

    const result = run('apply', TEST_DIR);
    expect(result.stdout).toContain('version mismatch');
    expect(result.stdout).toContain('patch: 1.0.0');
    expect(result.stdout).toContain('installed: 2.0.0');
  });

  test('checks the version of the package the patch actually targets', () => {
    // Имя файла патча и каталог в node_modules расходятся — так выглядит
    // установка через алиас. Раньше проверка версии шла по имени файла,
    // упиралась в несуществующий манифест и молча пропадала.
    setupFakePackage(TEST_DIR, 'test-lib', '2.0.0', {
      'index.js': 'const a = 1;\n',
    });

    mkdirSync(join(TEST_DIR, 'patches'), {recursive: true});
    const patchContent = `--- a/node_modules/test-lib/index.js
+++ b/node_modules/test-lib/index.js
@@ -1 +1 @@
-const a = 1;
+const a = 2;
`;
    writeFileSync(join(TEST_DIR, 'patches', 'other-name+1.0.0.patch'), patchContent);

    const result = run('apply', TEST_DIR);
    expect(result.stdout).toContain('version mismatch');
    expect(result.stdout).toContain('patch: 1.0.0');
    expect(result.stdout).toContain('installed: 2.0.0');
  });

  test('handles already applied patch', () => {
    // Создаём патч через create, не откатываем — патч уже применён
    execSync('bun add is-number@7.0.0', {cwd: TEST_DIR, stdio: 'pipe'});
    const indexPath = join(TEST_DIR, 'node_modules', 'is-number', 'index.js');
    const original = readFileSync(indexPath, 'utf-8');
    overwriteFile(indexPath, original + '\n// already-applied-marker');

    run('create is-number', TEST_DIR);

    // Применяем патч — он уже применён
    const result = run('apply', TEST_DIR);
    expect(result.stdout).toContain('already applied');
    expect(result.exitCode).toBe(0);
  });

  test('marks unappliable patch as failed', () => {
    setupFakePackage(TEST_DIR, 'test-lib', '1.0.0', {
      'index.js': 'const a = 1;',
    });

    mkdirSync(join(TEST_DIR, 'patches'), {recursive: true});
    const patchContent = `--- a/node_modules/test-lib/missing.js
+++ b/node_modules/test-lib/missing.js
@@ -1 +1 @@
-const a = 1;
+const a = 2;
`;
    writeFileSync(join(TEST_DIR, 'patches', 'test-lib+1.0.0.patch'), patchContent);

    const result = run('apply', TEST_DIR);
    expect(result.stdout).not.toContain('already applied');
    expect(result.stdout).toContain('0 applied, 1 failed');
    expect(result.exitCode).not.toBe(0);
  });

  test('prints a diagnostic when a hunk does not fit', () => {
    setupFakePackage(TEST_DIR, 'test-lib', '1.0.0', {
      'index.js': 'const totally = "different";',
    });

    mkdirSync(join(TEST_DIR, 'patches'), {recursive: true});
    const patchContent = `--- a/node_modules/test-lib/index.js
+++ b/node_modules/test-lib/index.js
@@ -1 +1 @@
-const a = 1;
+const a = 2;
`;
    writeFileSync(join(TEST_DIR, 'patches', 'test-lib+1.0.0.patch'), patchContent);

    const result = run('apply', TEST_DIR);
    expect(result.stdout).toContain('0 applied, 1 failed');
    // Apple patch пишет 'hunks failed', GNU — 'hunk FAILED'.
    expect(result.stdout).toMatch(/hunk/i);
  });

  test('rejects patch with absolute paths left by old versions', () => {
    setupFakePackage(TEST_DIR, 'test-lib', '1.0.0', {
      'index.js': 'const a = 1;',
    });

    mkdirSync(join(TEST_DIR, 'patches'), {recursive: true});
    const patchContent = `--- /Users/someone/proj/.bunch-patch-tmp/node_modules/test-lib/index.js
+++ /Users/someone/proj/node_modules/test-lib/index.js
@@ -1 +1 @@
-const a = 1;
+const a = 2;
`;
    writeFileSync(join(TEST_DIR, 'patches', 'test-lib+1.0.0.patch'), patchContent);

    const result = run('apply', TEST_DIR);
    expect(result.stdout).not.toContain('already applied');
    expect(result.stdout).toContain('absolute path in patch header');
    expect(result.stdout).toContain('0 applied, 1 failed');
    expect(result.exitCode).not.toBe(0);

    const untouched = readFileSync(join(TEST_DIR, 'node_modules', 'test-lib', 'index.js'), 'utf-8');
    expect(untouched).toBe('const a = 1;');
  });

  test('applies a patch that edits a line starting with "-- /"', () => {
    // Удаляемая строка кода `-- /etc/config` выглядит в диффе как `--- /etc/config`
    // и не должна приниматься за заголовок с абсолютным путём.
    setupFakePackage(TEST_DIR, 'test-lib', '1.0.0', {
      'index.js': '-- /etc/config is the default\nconst a = 1;\n',
    });

    mkdirSync(join(TEST_DIR, 'patches'), {recursive: true});
    const patchContent = `--- a/node_modules/test-lib/index.js
+++ b/node_modules/test-lib/index.js
@@ -1,2 +1,2 @@
--- /etc/config is the default
+-- /etc/config is the new default
 const a = 1;
`;
    writeFileSync(join(TEST_DIR, 'patches', 'test-lib+1.0.0.patch'), patchContent);

    const result = run('apply', TEST_DIR);
    expect(result.stdout).not.toContain('absolute path');
    expect(result.stdout).toContain('1 applied, 0 failed');
    expect(result.exitCode).toBe(0);

    const patched = readFileSync(join(TEST_DIR, 'node_modules', 'test-lib', 'index.js'), 'utf-8');
    expect(patched).toContain('is the new default');
  });

  test('treats a patch with no hunks as failed', () => {
    setupFakePackage(TEST_DIR, 'test-lib', '1.0.0', {
      'index.js': 'const a = 1;',
    });

    mkdirSync(join(TEST_DIR, 'patches'), {recursive: true});
    writeFileSync(join(TEST_DIR, 'patches', 'test-lib+1.0.0.patch'), '');

    const result = run('apply', TEST_DIR);
    expect(result.stdout).not.toContain('already applied');
    expect(result.stdout).toContain('no hunks found');
    expect(result.stdout).toContain('0 applied, 1 failed');
    expect(result.exitCode).not.toBe(0);
  });

  test('keeps going when a patches/ entry cannot be read', () => {
    setupFakePackage(TEST_DIR, 'test-lib', '1.0.0', {
      'index.js': 'const a = 1;\n',
    });

    mkdirSync(join(TEST_DIR, 'patches'), {recursive: true});
    const patchContent = `--- a/node_modules/test-lib/index.js
+++ b/node_modules/test-lib/index.js
@@ -1 +1 @@
-const a = 1;
+const a = 2;
`;
    writeFileSync(join(TEST_DIR, 'patches', 'test-lib+1.0.0.patch'), patchContent);
    // Каталог с расширением .patch проходит фильтр readdirSync, но не читается.
    mkdirSync(join(TEST_DIR, 'patches', 'unreadable.patch'), {recursive: true});

    const result = run('apply', TEST_DIR);
    expect(result.stdout).toContain('cannot read patch file');
    expect(result.stdout).toContain('1 applied, 1 failed');
    expect(result.exitCode).not.toBe(0);

    // Исправный патч всё равно должен примениться.
    const patched = readFileSync(join(TEST_DIR, 'node_modules', 'test-lib', 'index.js'), 'utf-8');
    expect(patched).toContain('const a = 2;');
  });

  test('deletes a file the patch removes, and stays idempotent', () => {
    setupFakePackage(TEST_DIR, 'test-lib', '1.0.0', {
      'keep.js': 'keep\n',
      'gone.js': 'goes away\n',
    });

    mkdirSync(join(TEST_DIR, 'patches'), {recursive: true});
    const patchContent = `--- a/node_modules/test-lib/gone.js
+++ b/node_modules/test-lib/gone.js
@@ -1 +0,0 @@
-goes away
`;
    writeFileSync(join(TEST_DIR, 'patches', 'test-lib+1.0.0.patch'), patchContent);

    const first = run('apply', TEST_DIR);
    expect(first.stdout).toContain('1 applied, 0 failed');
    expect(first.exitCode).toBe(0);
    // patch(1) оставлял на этом месте пустышку — отсюда и росла неидемпотентность.
    expect(existsSync(join(TEST_DIR, 'node_modules', 'test-lib', 'gone.js'))).toBe(false);
    expect(existsSync(join(TEST_DIR, 'node_modules', 'test-lib', 'keep.js'))).toBe(true);

    const second = run('apply', TEST_DIR);
    expect(second.stdout).toContain('already applied');
    expect(second.exitCode).toBe(0);
  });

  test('writes nothing when one file of a patch does not fit', () => {
    setupFakePackage(TEST_DIR, 'test-lib', '1.0.0', {
      'one.js': 'const a = 1;\n',
      'two.js': 'something else entirely\n',
    });

    mkdirSync(join(TEST_DIR, 'patches'), {recursive: true});
    const patchContent = `--- a/node_modules/test-lib/one.js
+++ b/node_modules/test-lib/one.js
@@ -1 +1 @@
-const a = 1;
+const a = 2;
--- a/node_modules/test-lib/two.js
+++ b/node_modules/test-lib/two.js
@@ -1 +1 @@
-const b = 1;
+const b = 2;
`;
    writeFileSync(join(TEST_DIR, 'patches', 'test-lib+1.0.0.patch'), patchContent);

    const result = run('apply', TEST_DIR);
    expect(result.stdout).toContain('0 applied, 1 failed');
    expect(result.exitCode).not.toBe(0);

    // Первый файл лёг бы без труда — но патч не сошёлся целиком, значит на диск
    // не идёт ничего. Раньше дерево оставалось наполовину пропатченным.
    const one = readFileSync(join(TEST_DIR, 'node_modules', 'test-lib', 'one.js'), 'utf-8');
    expect(one).toBe('const a = 1;\n');

    // И никакого мусора рядом с файлами.
    const leftovers = readdirSync(join(TEST_DIR, 'node_modules', 'test-lib'))
      .filter(name => name.endsWith('.rej') || name.endsWith('.orig'));
    expect(leftovers).toEqual([]);
  });

  test.skipIf(isWindows)('keeps the executable bit of a file it patches', () => {
    setupFakePackage(TEST_DIR, 'test-lib', '1.0.0', {
      'run.sh': '#!/bin/sh\necho one\n',
    });
    const script = join(TEST_DIR, 'node_modules', 'test-lib', 'run.sh');
    chmodSync(script, 0o755);

    mkdirSync(join(TEST_DIR, 'patches'), {recursive: true});
    const patchContent = `--- a/node_modules/test-lib/run.sh
+++ b/node_modules/test-lib/run.sh
@@ -1,2 +1,2 @@
 #!/bin/sh
-echo one
+echo two
`;
    writeFileSync(join(TEST_DIR, 'patches', 'test-lib+1.0.0.patch'), patchContent);

    const result = run('apply', TEST_DIR);
    expect(result.stdout).toContain('1 applied, 0 failed');
    expect(readFileSync(script, 'utf-8')).toContain('echo two');
    // Запись идёт через пересоздание файла, поэтому режим надо проставлять заново.
    expect(isExecutable(script)).toBe(true);
  });

  test('applies a patch that changes nothing but the mode', () => {
    setupFakePackage(TEST_DIR, 'test-lib', '1.0.0', {
      'run.sh': '#!/bin/sh\n',
    });
    const script = join(TEST_DIR, 'node_modules', 'test-lib', 'run.sh');
    chmodSync(script, 0o644);

    mkdirSync(join(TEST_DIR, 'patches'), {recursive: true});
    // Секция без хунков и без ---/+++: путь есть только в строке diff --git.
    const patchContent = `diff --git a/node_modules/test-lib/run.sh b/node_modules/test-lib/run.sh
old mode 100644
new mode 100755
`;
    writeFileSync(join(TEST_DIR, 'patches', 'test-lib+1.0.0.patch'), patchContent);

    // Сценарий кросс-платформенный: патч сделан на POSIX-машине, а применяется
    // где угодно. На Windows выставлять нечего, поэтому там это сразу «уже
    // применён» — но упасть или сработать дважды не должно нигде.
    const result = run('apply', TEST_DIR);
    expect(result.exitCode).toBe(0);
    if (isWindows) {
      expect(result.stdout).toContain('already applied');
    } else {
      expect(result.stdout).toContain('1 applied, 0 failed');
      expect(isExecutable(script)).toBe(true);
    }

    const again = run('apply', TEST_DIR);
    expect(again.stdout).toContain('already applied');
    expect(again.exitCode).toBe(0);
  });

  test('tolerates trailing whitespace stripped from context lines', () => {
    // Пустая строка с отступом превращается в пустую совсем: их срезают
    // редакторы, линтеры и веб-интерфейс GitHub. На корпусе реальных патчей
    // это была причина девяти отказов из семнадцати.
    setupFakePackage(TEST_DIR, 'test-lib', '1.0.0', {
      'index.js': 'const a = 1;\n    \nconst b = 2;\n',
    });

    mkdirSync(join(TEST_DIR, 'patches'), {recursive: true});
    // Строка контекста между ними в патче пустая, а в файле — четыре пробела.
    const patchContent = `--- a/node_modules/test-lib/index.js
+++ b/node_modules/test-lib/index.js
@@ -1,3 +1,3 @@
 const a = 1;

-const b = 2;
+const b = 3;
`;
    writeFileSync(join(TEST_DIR, 'patches', 'test-lib+1.0.0.patch'), patchContent);

    const result = run('apply', TEST_DIR);
    expect(result.stdout).toContain('1 applied, 0 failed');

    // Контекст берётся из файла, а не из патча: отступ должен уцелеть.
    const patched = readFileSync(join(TEST_DIR, 'node_modules', 'test-lib', 'index.js'), 'utf-8');
    expect(patched).toBe('const a = 1;\n    \nconst b = 3;\n');
  });

  test('reads a patch written with CRLF line endings', () => {
    setupFakePackage(TEST_DIR, 'test-lib', '1.0.0', {
      'index.js': 'const a = 1;\n',
    });

    mkdirSync(join(TEST_DIR, 'patches'), {recursive: true});
    // \r уезжал в путь из заголовка, файл «не находился», и патч не ложился.
    const patchContent = ['--- a/node_modules/test-lib/index.js',
      '+++ b/node_modules/test-lib/index.js',
      '@@ -1 +1 @@',
      '-const a = 1;',
      '+const a = 2;',
      ''].join('\r\n');
    writeFileSync(join(TEST_DIR, 'patches', 'test-lib+1.0.0.patch'), patchContent);

    const result = run('apply', TEST_DIR);
    expect(result.stdout).toContain('1 applied, 0 failed');
    expect(readFileSync(join(TEST_DIR, 'node_modules', 'test-lib', 'index.js'), 'utf-8')).toContain('const a = 2;');
  });

  test('creates an empty file declared by new file mode alone', () => {
    setupFakePackage(TEST_DIR, 'test-lib', '1.0.0', {'index.js': 'const a = 1;\n'});
    mkdirSync(join(TEST_DIR, 'patches'), {recursive: true});
    // Так git записывает создание пустышки: режим есть, хунков нет.
    const patchContent = `diff --git a/node_modules/test-lib/marker b/node_modules/test-lib/marker
new file mode 100644
`;
    writeFileSync(join(TEST_DIR, 'patches', 'test-lib+1.0.0.patch'), patchContent);

    const result = run('apply', TEST_DIR);
    expect(result.stdout).toContain('1 applied, 0 failed');
    const created = join(TEST_DIR, 'node_modules', 'test-lib', 'marker');
    expect(existsSync(created)).toBe(true);
    expect(readFileSync(created, 'utf-8')).toBe('');
  });

  test('renames a file and stays idempotent', () => {
    setupFakePackage(TEST_DIR, 'test-lib', '1.0.0', {'old.txt': 'stays the same\n'});
    mkdirSync(join(TEST_DIR, 'patches'), {recursive: true});
    // git пишет пути переименования без префиксов a/ и b/.
    const patchContent = `diff --git a/node_modules/test-lib/old.txt b/node_modules/test-lib/new.txt
similarity index 100%
rename from node_modules/test-lib/old.txt
rename to node_modules/test-lib/new.txt
`;
    writeFileSync(join(TEST_DIR, 'patches', 'test-lib+1.0.0.patch'), patchContent);

    const result = run('apply', TEST_DIR);
    expect(result.stdout).toContain('1 applied, 0 failed');
    expect(existsSync(join(TEST_DIR, 'node_modules', 'test-lib', 'old.txt'))).toBe(false);
    expect(readFileSync(join(TEST_DIR, 'node_modules', 'test-lib', 'new.txt'), 'utf-8')).toBe('stays the same\n');

    const again = run('apply', TEST_DIR);
    expect(again.exitCode).toBe(0);
  });

  test('does not mistake an unapplied patch for an applied one', () => {
    // Хунк срезает первые строки файла. Новая сторона встречается в файле со
    // смещением, и поиск по всему файлу объявлял патч уже применённым.
    setupFakePackage(TEST_DIR, 'test-lib', '1.0.0', {
      'index.js': '#!/usr/bin/env node\n\nconst a = 1;\nconst b = 2;\n',
    });

    mkdirSync(join(TEST_DIR, 'patches'), {recursive: true});
    const patchContent = `--- a/node_modules/test-lib/index.js
+++ b/node_modules/test-lib/index.js
@@ -1,4 +1,2 @@
-#!/usr/bin/env node
-
 const a = 1;
 const b = 2;
`;
    writeFileSync(join(TEST_DIR, 'patches', 'test-lib+1.0.0.patch'), patchContent);

    const result = run('apply', TEST_DIR);
    expect(result.stdout).not.toContain('already applied');
    expect(result.stdout).toContain('1 applied, 0 failed');
    expect(readFileSync(join(TEST_DIR, 'node_modules', 'test-lib', 'index.js'), 'utf-8'))
      .toBe('const a = 1;\nconst b = 2;\n');
  });

  test('refuses a patch whose path escapes the project', () => {
    mkdirSync(join(TEST_DIR, 'patches'), {recursive: true});
    const patchContent = `--- a/../../ESCAPED.txt
+++ b/../../ESCAPED.txt
@@ -0,0 +1 @@
+escaped the project root
`;
    writeFileSync(join(TEST_DIR, 'patches', 'evil+1.0.0.patch'), patchContent);

    const result = run('apply', TEST_DIR);
    expect(result.stdout).toContain('outside the project');
    expect(result.stdout).toContain('0 applied, 1 failed');
    expect(result.exitCode).not.toBe(0);
    // Раньше это зависело от реализации: GNU patch отказывал, Apple писал файл.
    expect(existsSync(join(TEST_DIR, '..', 'ESCAPED.txt'))).toBe(false);
  });

  test('refuses to fabricate a package that is not installed', () => {
    mkdirSync(join(TEST_DIR, 'node_modules'), {recursive: true});
    mkdirSync(join(TEST_DIR, 'patches'), {recursive: true});
    const patchContent = `--- a/node_modules/ghost/new.js
+++ b/node_modules/ghost/new.js
@@ -0,0 +1 @@
+fabricated
`;
    writeFileSync(join(TEST_DIR, 'patches', 'ghost+1.0.0.patch'), patchContent);

    const result = run('apply', TEST_DIR);
    expect(result.stdout).toContain('not installed');
    expect(result.stdout).toContain('0 applied, 1 failed');
    expect(result.exitCode).not.toBe(0);
    expect(existsSync(join(TEST_DIR, 'node_modules', 'ghost'))).toBe(false);
  });

  test('survives a corrupt package.json in node_modules', () => {
    setupFakePackage(TEST_DIR, 'test-lib', '1.0.0', {
      'index.js': 'const a = 1;\n',
    });
    writeFileSync(join(TEST_DIR, 'node_modules', 'test-lib', 'package.json'), '{ not json');

    mkdirSync(join(TEST_DIR, 'patches'), {recursive: true});
    const patchContent = `--- a/node_modules/test-lib/index.js
+++ b/node_modules/test-lib/index.js
@@ -1 +1 @@
-const a = 1;
+const a = 2;
`;
    writeFileSync(join(TEST_DIR, 'patches', 'test-lib+1.0.0.patch'), patchContent);

    const result = run('apply', TEST_DIR);
    expect(result.stdout).toContain('skipping version check');
    expect(result.stdout).toContain('1 applied, 0 failed');
    expect(result.exitCode).toBe(0);
  });
});

// bun с 1.2 патчит пакеты сам: `bun patch --commit` кладёт файл в тот же
// patches/ и записывает его в `patchedDependencies`. Пути в таком патче — от
// корня пакета, а не от корня проекта, и раньше мы срезали `a/` и били по
// файлам самого проекта: `apply` переписывал ./index.js и печатал `✅ 1 applied`.
describe('patches that belong to bun', () => {
  const BUN_PATCH = `diff --git a/index.js b/index.js
index c4498bcc..74988d81 100644
--- a/index.js
+++ b/index.js
@@ -1,1 +1,1 @@
-const original = 1;
+const patchedByBun = 2;
`;

  function setupProjectFile(patchedDependencies?: Record<string, string>) {
    writeFileSync(
      join(TEST_DIR, 'package.json'),
      JSON.stringify({name: 'test-project', version: '1.0.0', ...(patchedDependencies ? {patchedDependencies} : {})}),
    );
    // Файл проекта, по которому патч bun и попадал: путь `a/index.js` мы
    // решали от корня проекта.
    overwriteFile(join(TEST_DIR, 'index.js'), 'const original = 1;\n');
    mkdirSync(join(TEST_DIR, 'patches'), {recursive: true});
    writeFileSync(join(TEST_DIR, 'patches', 'ms@2.1.2.patch'), BUN_PATCH);
  }

  test('apply leaves them to bun and does not touch the project', () => {
    setupProjectFile({'ms@2.1.2': 'patches/ms@2.1.2.patch'});

    const result = run('apply', TEST_DIR);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('bun applies this one itself');
    expect(readFileSync(join(TEST_DIR, 'index.js'), 'utf-8')).toBe('const original = 1;\n');
  });

  test('apply refuses one that is not even listed, instead of patching the project', () => {
    // Тот же патч, но в patchedDependencies его нет: единственный признак — пути.
    setupProjectFile();

    const result = run('apply', TEST_DIR);

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toContain('is not inside node_modules/');
    expect(readFileSync(join(TEST_DIR, 'index.js'), 'utf-8')).toBe('const original = 1;\n');
  });

  test('status names them instead of counting them as ours', () => {
    setupProjectFile({'ms@2.1.2': 'patches/ms@2.1.2.patch'});

    const result = run('status', TEST_DIR);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('applied by bun itself');
    expect(result.stdout).toContain('ms@2.1.2.patch');
    expect(result.stdout).toContain('📋 0 patch(es)');
  });

  test('reverse leaves them alone instead of rolling back a project file', () => {
    // Файл проекта выглядит так, будто патч bun уже лёг: обратная сторона
    // сходится, и `reverse`, взявшись за чужой патч, откатил бы исходник
    // проекта. Никакой другой защиты здесь нет — `unApply` спрашивает про общий
    // стор и про то, лежит ли патч в дереве, но про формат путей не спрашивает.
    // Проверено снятием фильтра: `↩️ ms@2.1.2.patch` и index.js проекта,
    // вернувшийся к `const original = 1;`.
    setupProjectFile({'ms@2.1.2': 'patches/ms@2.1.2.patch'});
    overwriteFile(join(TEST_DIR, 'index.js'), 'const patchedByBun = 2;\n');

    const result = run('reverse', TEST_DIR);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('No patches to un-apply');
    expect(readFileSync(join(TEST_DIR, 'index.js'), 'utf-8')).toBe('const patchedByBun = 2;\n');
  });

  test('reverse refuses one that is not listed, instead of editing the project', () => {
    // Патч чужого формата, которого нет в patchedDependencies: фильтр по
    // манифесту его не поймает, а формат путей откат до этого не проверял
    // вовсе. Измерено на этом же стенде до правки: `↩️ ms@2.1.2.patch`,
    // `1 of 1 un-applied` и index.js проекта, вернувшийся к `const original`.
    setupProjectFile();
    overwriteFile(join(TEST_DIR, 'index.js'), 'const patchedByBun = 2;\n');

    const result = run('reverse', TEST_DIR);

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toContain('is not inside node_modules/');
    expect(result.stdout).toContain('0 of 1 un-applied');
    expect(readFileSync(join(TEST_DIR, 'index.js'), 'utf-8')).toBe('const patchedByBun = 2;\n');
  });

  test('rebase refuses it too, whatever the patch file is called', () => {
    // Имя файла о формате не говорит ничего: чужой патч переименовывают руками,
    // и `import` занят ровно этим. Под нашим именем его берёт и rebase — он
    // ищет патчи пакета разбором имени, а снимает тем же кодом, что reverse.
    setupProjectFile();
    unlinkSync(join(TEST_DIR, 'patches', 'ms@2.1.2.patch'));
    writeFileSync(join(TEST_DIR, 'patches', 'ms+2.1.2.patch'), BUN_PATCH);
    overwriteFile(join(TEST_DIR, 'index.js'), 'const patchedByBun = 2;\n');

    const result = run('rebase ms 0', TEST_DIR);

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toContain('is not inside node_modules/');
    expect(readFileSync(join(TEST_DIR, 'index.js'), 'utf-8')).toBe('const patchedByBun = 2;\n');
  });

  test('create refuses a package bun already patches', () => {
    setupFakePackage(TEST_DIR, 'test-lib', '1.0.0', {'index.js': 'const a = 1;\n'});
    writeFileSync(
      join(TEST_DIR, 'package.json'),
      JSON.stringify({
        name: 'test-project',
        version: '1.0.0',
        patchedDependencies: {'test-lib@1.0.0': 'patches/test-lib@1.0.0.patch'},
      }),
    );

    const result = run('create test-lib', TEST_DIR);

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toContain('already patched by bun');
    // Отказ до сети: эталон не качается.
    expect(result.stdout).not.toContain('Fetching pristine');
  });
});

// Форматов в обиходе три. Наш и patch-package'овский совпадают, а bun пишет
// иначе: имя `ms@2.1.2.patch` (у scoped-пакетов слэш закодирован как %2F) и пути
// от корня пакета. Десяток таких файлов руками никто не перепишет.
describe('import', () => {
  const BUN_PATCH = `diff --git a/node_modules/@scope/pkg/.bun-tag-abc123 b/.bun-tag-abc123
new file mode 100644
index 0000000000000000000000000000000000000000..e69de29bb2d1d6434b8b29ae775ad8c2e48c5391
diff --git a/index.js b/index.js
index 1111111111111111111111111111111111111111..2222222222222222222222222222222222222222 100644
--- a/index.js
+++ b/index.js
@@ -1,1 +1,1 @@
-const a = 1;
+const a = 2;
`;

  function setupBunPatch() {
    setupFakePackage(TEST_DIR, '@scope/pkg', '1.0.0', {'index.js': 'const a = 1;\n'});
    writeFileSync(
      join(TEST_DIR, 'package.json'),
      JSON.stringify(
        {
          name: 'test-project',
          version: '1.0.0',
          patchedDependencies: {'@scope/pkg@1.0.0': 'patches/@scope%2Fpkg@1.0.0.patch'},
        },
        null,
        2,
      ),
    );
    mkdirSync(join(TEST_DIR, 'patches'), {recursive: true});
    writeFileSync(join(TEST_DIR, 'patches', '@scope%2Fpkg@1.0.0.patch'), BUN_PATCH);
  }

  test('converts a bun patch, name and paths, and hands it to apply', () => {
    setupBunPatch();

    const result = run('import', TEST_DIR);

    expect(result.exitCode).toBe(0);
    expect(readdirSync(join(TEST_DIR, 'patches'))).toEqual(['@scope+pkg+1.0.0.patch']);

    const converted = readFileSync(join(TEST_DIR, 'patches', '@scope+pkg+1.0.0.patch'), 'utf-8');
    expect(converted).toContain('--- a/node_modules/@scope/pkg/index.js');
    expect(converted).toContain('+++ b/node_modules/@scope/pkg/index.js');
    // Служебный файл, который bun заводит себе на время правки, в дереве пакета
    // делать нечего.
    expect(converted).not.toContain('.bun-tag-');

    expect(run('apply', TEST_DIR).exitCode).toBe(0);
    expect(readFileSync(join(TEST_DIR, 'node_modules', '@scope', 'pkg', 'index.js'), 'utf-8')).toBe('const a = 2;\n');
    expect(existsSync(join(TEST_DIR, 'node_modules', '@scope', 'pkg', '.bun-tag-abc123'))).toBe(false);
  });

  test('takes the patch out of patchedDependencies, so bun stops looking for it', () => {
    setupBunPatch();

    run('import', TEST_DIR);

    const manifest = JSON.parse(readFileSync(join(TEST_DIR, 'package.json'), 'utf-8'));
    expect(manifest.patchedDependencies).toBeUndefined();
    // Остальное в манифесте не тронуто.
    expect(manifest.name).toBe('test-project');
  });

  test('says so when there is nothing to import', () => {
    setupFakePackage(TEST_DIR, 'test-lib', '1.0.0', {'index.js': 'const a = 1;\n'});
    mkdirSync(join(TEST_DIR, 'patches'), {recursive: true});
    writeFileSync(join(TEST_DIR, 'patches', 'test-lib+1.0.0.patch'), `--- a/node_modules/test-lib/index.js
+++ b/node_modules/test-lib/index.js
@@ -1 +1 @@
-const a = 1;
+const a = 2;
`);

    const result = run('import', TEST_DIR);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Nothing to import');
    expect(readdirSync(join(TEST_DIR, 'patches'))).toEqual(['test-lib+1.0.0.patch']);
  });

  // Настоящий `bun patch`, а не рукописный образец: формат его патча — то, что
  // мы обещаем понимать, и меняет его bun, а не мы.
  test('a patch made by bun itself ends up applying the same bytes', () => {
    execSync('bun add ms@2.1.2', {cwd: TEST_DIR, stdio: 'pipe'});
    execSync('bun patch ms@2.1.2', {cwd: TEST_DIR, stdio: 'pipe'});
    const file = join(TEST_DIR, 'node_modules', 'ms', 'index.js');
    overwriteFile(file, readFileSync(file, 'utf-8').replace('var s = 1000;', 'var s = 1000; // MY FIX'));
    execSync('bun patch --commit node_modules/ms', {cwd: TEST_DIR, stdio: 'pipe'});
    const byBun = readFileSync(file, 'utf-8');

    expect(run('import', TEST_DIR).exitCode).toBe(0);
    expect(existsSync(join(TEST_DIR, 'patches', 'ms+2.1.2.patch'))).toBe(true);

    // Чистая установка: bun больше не патчит, потому что записи о патче нет.
    rmSync(join(TEST_DIR, 'node_modules'), {force: true, recursive: true});
    execSync('bun install', {cwd: TEST_DIR, stdio: 'pipe'});
    expect(readFileSync(file, 'utf-8')).not.toContain('MY FIX');

    expect(run('apply', TEST_DIR).exitCode).toBe(0);
    expect(readFileSync(file, 'utf-8')).toBe(byBun);
  });
});

// export — обратная команда к import: переводит наш формат обратно в формат
// bun patch, чтобы bun install применял патч сам, без postinstall.
describe('export', () => {
  // Простой патч в нашем формате (пути от корня проекта): именно он живёт в
  // patches/ после import или create.
  const BUNCH_PATCH = `diff --git a/node_modules/@scope/pkg/index.js b/node_modules/@scope/pkg/index.js
index 1111111111111111111111111111111111111111..2222222222222222222222222222222222222222 100644
--- a/node_modules/@scope/pkg/index.js
+++ b/node_modules/@scope/pkg/index.js
@@ -1,1 +1,1 @@
-const a = 1;
+const a = 2;
`;

  // Тот же патч, но в формате bun: имя с %2F, пути от корня пакета.
  const BUN_PATCH = `diff --git a/index.js b/index.js
index 1111111111111111111111111111111111111111..2222222222222222222222222222222222222222 100644
--- a/index.js
+++ b/index.js
@@ -1,1 +1,1 @@
-const a = 1;
+const a = 2;
`;

  function setupBunchPatch() {
    setupFakePackage(TEST_DIR, '@scope/pkg', '1.0.0', {'index.js': 'const a = 1;\n'});
    writeFileSync(
      join(TEST_DIR, 'package.json'),
      JSON.stringify({name: 'test-project', version: '1.0.0'}, null, 2),
    );
    mkdirSync(join(TEST_DIR, 'patches'), {recursive: true});
    writeFileSync(join(TEST_DIR, 'patches', '@scope+pkg+1.0.0.patch'), BUNCH_PATCH);
  }

  test('converts a bunch-package patch to bun format: renames and rewrites paths', () => {
    setupBunchPatch();

    const result = run('export', TEST_DIR);

    expect(result.exitCode).toBe(0);
    expect(readdirSync(join(TEST_DIR, 'patches'))).toEqual(['@scope%2Fpkg@1.0.0.patch']);

    const converted = readFileSync(join(TEST_DIR, 'patches', '@scope%2Fpkg@1.0.0.patch'), 'utf-8');
    expect(converted).toBe(BUN_PATCH);
  });

  test('adds the patch to patchedDependencies so bun installs it', () => {
    setupBunchPatch();

    run('export', TEST_DIR);

    const manifest = JSON.parse(readFileSync(join(TEST_DIR, 'package.json'), 'utf-8'));
    expect(manifest.patchedDependencies?.['@scope/pkg@1.0.0']).toBe('patches/@scope%2Fpkg@1.0.0.patch');
    // Остальное в манифесте не тронуто.
    expect(manifest.name).toBe('test-project');
  });

  test('says so when there is nothing to export', () => {
    mkdirSync(join(TEST_DIR, 'patches'), {recursive: true});

    const result = run('export', TEST_DIR);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('No patches to export');
  });

  test('refuses a dev-only patch — bun does not support them', () => {
    setupFakePackage(TEST_DIR, 'test-lib', '1.0.0', {'index.js': 'const a = 1;\n'});
    mkdirSync(join(TEST_DIR, 'patches'), {recursive: true});
    writeFileSync(join(TEST_DIR, 'patches', 'test-lib+1.0.0.dev.patch'), `--- a/node_modules/test-lib/index.js
+++ b/node_modules/test-lib/index.js
@@ -1 +1 @@
-const a = 1;
+const a = 2;
`);

    const result = run('export', TEST_DIR);

    expect(result.exitCode).toBe(0);
    // Отказ внятный: пользователь понимает, почему файл не переехал.
    expect(result.stdout).toContain('bun does not support dev-only patches');
    // Файл не тронут.
    expect(existsSync(join(TEST_DIR, 'patches', 'test-lib+1.0.0.dev.patch'))).toBe(true);
  });

  test('refuses a nested dependency — bun does not support them', () => {
    mkdirSync(join(TEST_DIR, 'patches'), {recursive: true});
    writeFileSync(join(TEST_DIR, 'patches', 'outer++inner+1.0.0.patch'), `--- a/node_modules/outer/node_modules/inner/index.js
+++ b/node_modules/outer/node_modules/inner/index.js
@@ -1 +1 @@
-const a = 1;
+const a = 2;
`);

    const result = run('export', TEST_DIR);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('bun does not support nested dependencies');
    expect(existsSync(join(TEST_DIR, 'patches', 'outer++inner+1.0.0.patch'))).toBe(true);
  });

  test('refuses a patch sequence — bun supports only one patch per package', () => {
    mkdirSync(join(TEST_DIR, 'patches'), {recursive: true});
    writeFileSync(join(TEST_DIR, 'patches', 'test-lib+1.0.0+001+first.patch'), `--- a/node_modules/test-lib/index.js
+++ b/node_modules/test-lib/index.js
@@ -1 +1 @@
-const a = 1;
+const a = 2;
`);
    writeFileSync(join(TEST_DIR, 'patches', 'test-lib+1.0.0+002+second.patch'), `--- a/node_modules/test-lib/index.js
+++ b/node_modules/test-lib/index.js
@@ -1 +1 @@
-const a = 2;
+const a = 3;
`);

    const result = run('export', TEST_DIR);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('bun supports only one patch per package');
    // Ни один из файлов последовательности не тронут.
    expect(existsSync(join(TEST_DIR, 'patches', 'test-lib+1.0.0+001+first.patch'))).toBe(true);
    expect(existsSync(join(TEST_DIR, 'patches', 'test-lib+1.0.0+002+second.patch'))).toBe(true);
  });

  test('exports only the named package when one is given', () => {
    setupFakePackage(TEST_DIR, 'pkg-a', '1.0.0', {'index.js': 'const a = 1;\n'});
    setupFakePackage(TEST_DIR, 'pkg-b', '2.0.0', {'index.js': 'const b = 1;\n'});
    mkdirSync(join(TEST_DIR, 'patches'), {recursive: true});
    const patchContent = (name: string) => `--- a/node_modules/${name}/index.js
+++ b/node_modules/${name}/index.js
@@ -1 +1 @@
-const a = 1;
+const a = 2;
`;
    writeFileSync(join(TEST_DIR, 'patches', 'pkg-a+1.0.0.patch'), patchContent('pkg-a'));
    writeFileSync(join(TEST_DIR, 'patches', 'pkg-b+2.0.0.patch'), patchContent('pkg-b'));

    const result = run('export pkg-a', TEST_DIR);

    expect(result.exitCode).toBe(0);
    expect(existsSync(join(TEST_DIR, 'patches', 'pkg-a@1.0.0.patch'))).toBe(true);
    // pkg-b не тронут.
    expect(existsSync(join(TEST_DIR, 'patches', 'pkg-b+2.0.0.patch'))).toBe(true);
    expect(existsSync(join(TEST_DIR, 'patches', 'pkg-b@2.0.0.patch'))).toBe(false);
  });

  // Тест-инверсия: import → export возвращает исходный файл побайтово.
  // Обратная операция — лучший тест для прямой (INS-8).
  test('import followed by export returns the original bun patch byte-for-byte', () => {
    // Патч без .bun-tag- секции: import её дропает, поэтому инверсия
    // не включает её в зачёт.
    const bunPatch = BUN_PATCH;
    setupFakePackage(TEST_DIR, '@scope/pkg', '1.0.0', {'index.js': 'const a = 1;\n'});
    writeFileSync(
      join(TEST_DIR, 'package.json'),
      JSON.stringify(
        {
          name: 'test-project',
          version: '1.0.0',
          patchedDependencies: {'@scope/pkg@1.0.0': 'patches/@scope%2Fpkg@1.0.0.patch'},
        },
        null,
        2,
      ),
    );
    mkdirSync(join(TEST_DIR, 'patches'), {recursive: true});
    writeFileSync(join(TEST_DIR, 'patches', '@scope%2Fpkg@1.0.0.patch'), bunPatch);

    expect(run('import', TEST_DIR).exitCode).toBe(0);
    expect(run('export', TEST_DIR).exitCode).toBe(0);

    const result = readFileSync(join(TEST_DIR, 'patches', '@scope%2Fpkg@1.0.0.patch'), 'utf-8');
    expect(result).toBe(bunPatch);
  });

  // Тест-инверсия: export → import возвращает исходный файл побайтово.
  test('export followed by import returns the original bunch-package patch byte-for-byte', () => {
    setupBunchPatch();

    expect(run('export', TEST_DIR).exitCode).toBe(0);
    // После export: patchedDependencies есть, файл в bun-формате.
    expect(run('import', TEST_DIR).exitCode).toBe(0);

    const result = readFileSync(join(TEST_DIR, 'patches', '@scope+pkg+1.0.0.patch'), 'utf-8');
    expect(result).toBe(BUNCH_PATCH);
  });

  // Контрольный тест с настоящим bun: патч, экспортированный нами и применённый
  // bun install, даёт то же дерево, что наш apply. Зеркало аналогичного теста
  // для import.
  test('a patch exported by us ends up applying the same bytes when bun installs', () => {
    execSync('bun add ms@2.1.2', {cwd: TEST_DIR, stdio: 'pipe'});
    execSync('bun patch ms@2.1.2', {cwd: TEST_DIR, stdio: 'pipe'});
    const file = join(TEST_DIR, 'node_modules', 'ms', 'index.js');
    overwriteFile(file, readFileSync(file, 'utf-8').replace('var s = 1000;', 'var s = 1000; // MY FIX'));
    execSync('bun patch --commit node_modules/ms', {cwd: TEST_DIR, stdio: 'pipe'});

    // Переводим в наш формат.
    expect(run('import', TEST_DIR).exitCode).toBe(0);
    expect(existsSync(join(TEST_DIR, 'patches', 'ms+2.1.2.patch'))).toBe(true);

    // Что дает наш apply?
    rmSync(join(TEST_DIR, 'node_modules'), {force: true, recursive: true});
    execSync('bun install', {cwd: TEST_DIR, stdio: 'pipe'}); // patchedDependencies нет → patch не применяется
    expect(run('apply', TEST_DIR).exitCode).toBe(0);
    const byUs = readFileSync(file, 'utf-8');
    expect(byUs).toContain('MY FIX');

    // Экспортируем обратно в формат bun.
    expect(run('export', TEST_DIR).exitCode).toBe(0);
    expect(existsSync(join(TEST_DIR, 'patches', 'ms@2.1.2.patch'))).toBe(true);
    expect(existsSync(join(TEST_DIR, 'patches', 'ms+2.1.2.patch'))).toBe(false);

    // Что даёт bun install с нашим экспортированным патчем?
    rmSync(join(TEST_DIR, 'node_modules'), {force: true, recursive: true});
    execSync('bun install', {cwd: TEST_DIR, stdio: 'pipe'}); // bun применяет экспортированный патч

    expect(readFileSync(file, 'utf-8')).toBe(byUs);
  });
});

// Вложенная зависимость — `node_modules/outer/node_modules/inner` — появляется,
// когда версии конфликтуют, и bun разводит их именно так. patch-package пишет
// такие патчи через двойной плюс: `outer++inner+1.0.0.patch`.
describe('nested dependencies', () => {
  const NESTED_PATCH = `--- a/node_modules/outer/node_modules/inner/index.js
+++ b/node_modules/outer/node_modules/inner/index.js
@@ -1 +1 @@
-const a = 1;
+const a = 2;
`;

  function setupNested() {
    setupFakePackage(TEST_DIR, 'outer', '9.9.9', {'index.js': 'const outer = 1;\n'});
    setupFakePackage(TEST_DIR, join('outer', 'node_modules', 'inner'), '1.0.0', {'index.js': 'const a = 1;\n'});
    mkdirSync(join(TEST_DIR, 'patches'), {recursive: true});
    writeFileSync(join(TEST_DIR, 'patches', 'outer++inner+1.0.0.patch'), NESTED_PATCH);
  }

  const innerFile = () => join(TEST_DIR, 'node_modules', 'outer', 'node_modules', 'inner', 'index.js');

  test('applies without inventing a version mismatch', () => {
    setupNested();

    const result = run('apply', TEST_DIR);

    expect(result.exitCode).toBe(0);
    expect(readFileSync(innerFile(), 'utf-8')).toBe('const a = 2;\n');
    // Версия в имени патча — версия inner. Пока каталогом пакета считался outer,
    // она сверялась с манифестом outer и на каждый install печаталось ложное
    // `version mismatch (patch: 1.0.0, installed: 9.9.9)`.
    expect(result.stdout).not.toContain('version mismatch');
  });

  test('still warns when the nested version really differs', () => {
    setupNested();
    writeFileSync(
      join(TEST_DIR, 'node_modules', 'outer', 'node_modules', 'inner', 'package.json'),
      JSON.stringify({name: 'inner', version: '2.0.0'}),
    );

    const result = run('apply', TEST_DIR);

    expect(result.stdout).toContain('version mismatch (patch: 1.0.0, installed: 2.0.0)');
  });

  test('says which package is missing when the nested copy is not there', () => {
    setupFakePackage(TEST_DIR, 'outer', '9.9.9', {'index.js': 'const outer = 1;\n'});
    mkdirSync(join(TEST_DIR, 'patches'), {recursive: true});
    writeFileSync(join(TEST_DIR, 'patches', 'outer++inner+1.0.0.patch'), NESTED_PATCH);

    const result = run('apply', TEST_DIR);

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toContain('node_modules/outer/node_modules/inner is not installed');
  });

  test('status reads the nested name too', () => {
    setupNested();
    run('apply', TEST_DIR);

    const result = run('status', TEST_DIR);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('outer++inner+1.0.0.patch — in the tree');
  });

  // Создать патч для вложенной зависимости было нельзя вовсе: имя пакета с
  // путём не проходило проверку.
  test('create makes one, named the way patch-package names them', () => {
    execSync('bun add ms@2.1.2', {cwd: TEST_DIR, stdio: 'pipe'});
    setupFakePackage(TEST_DIR, 'outer', '9.9.9', {'index.js': 'const outer = 1;\n'});
    const nested = join(TEST_DIR, 'node_modules', 'outer', 'node_modules', 'ms');
    mkdirSync(join(nested, '..'), {recursive: true});
    cpSync(join(TEST_DIR, 'node_modules', 'ms'), nested, {recursive: true});
    overwriteFile(join(nested, 'index.js'), `// NESTED FIX\n${readFileSync(join(nested, 'index.js'), 'utf-8')}`);

    const result = run('create outer/node_modules/ms', TEST_DIR);

    expect(result.exitCode).toBe(0);
    expect(existsSync(join(TEST_DIR, 'patches', 'outer++ms+2.1.2.patch'))).toBe(true);

    const patch = readFileSync(join(TEST_DIR, 'patches', 'outer++ms+2.1.2.patch'), 'utf-8');
    expect(patch).toContain('a/node_modules/outer/node_modules/ms/index.js');
    expect(patch).toContain('+// NESTED FIX');
    // И он ложится обратно: снимаем правку и применяем.
    overwriteFile(join(nested, 'index.js'), readFileSync(join(TEST_DIR, 'node_modules', 'ms', 'index.js'), 'utf-8'));
    expect(run('apply', TEST_DIR).exitCode).toBe(0);
    expect(readFileSync(join(nested, 'index.js'), 'utf-8')).toContain('// NESTED FIX');
    // Пакет верхнего уровня при этом не тронут.
    expect(readFileSync(join(TEST_DIR, 'node_modules', 'ms', 'index.js'), 'utf-8')).not.toContain('NESTED FIX');
  });

  // Родню по последовательности искали сравнением префикса имени, а он не знал
  // про `outer++inner`: существующий патч не находился, и второй уезжал первым
  // в последовательности, унося правки первого.
  test('create --append finds the patch that is already there', () => {
    execSync('bun add ms@2.1.2', {cwd: TEST_DIR, stdio: 'pipe'});
    setupFakePackage(TEST_DIR, 'outer', '9.9.9', {'index.js': 'const outer = 1;\n'});
    const nested = join(TEST_DIR, 'node_modules', 'outer', 'node_modules', 'ms');
    mkdirSync(join(nested, '..'), {recursive: true});
    cpSync(join(TEST_DIR, 'node_modules', 'ms'), nested, {recursive: true});
    const file = join(nested, 'index.js');

    overwriteFile(file, `// FIRST\n${readFileSync(file, 'utf-8')}`);
    expect(run('create outer/node_modules/ms', TEST_DIR).exitCode).toBe(0);

    overwriteFile(file, `${readFileSync(file, 'utf-8')}\n// SECOND\n`);
    expect(run('create outer/node_modules/ms --append second', TEST_DIR).exitCode).toBe(0);

    expect(readdirSync(join(TEST_DIR, 'patches')).sort()).toEqual([
      'outer++ms+2.1.2+001+initial.patch',
      'outer++ms+2.1.2+002+second.patch',
    ]);
    const second = readFileSync(join(TEST_DIR, 'patches', 'outer++ms+2.1.2+002+second.patch'), 'utf-8');
    expect(second).toContain('+// SECOND');
    expect(second).not.toContain('FIRST');
  });

  test('retarget moves a nested patch to the version installed there', () => {
    execSync('bun add ms@2.1.2', {cwd: TEST_DIR, stdio: 'pipe'});
    setupFakePackage(TEST_DIR, 'outer', '9.9.9', {'index.js': 'const outer = 1;\n'});
    const nested = join(TEST_DIR, 'node_modules', 'outer', 'node_modules', 'ms');
    mkdirSync(join(nested, '..'), {recursive: true});
    cpSync(join(TEST_DIR, 'node_modules', 'ms'), nested, {recursive: true});
    overwriteFile(join(nested, 'index.js'), `// NESTED FIX\n${readFileSync(join(nested, 'index.js'), 'utf-8')}`);
    expect(run('create outer/node_modules/ms', TEST_DIR).exitCode).toBe(0);

    // Вложенную копию обновили, верхнюю — нет.
    rmSync(nested, {force: true, recursive: true});
    execSync('bun add ms@2.1.3', {cwd: TEST_DIR, stdio: 'pipe'});
    cpSync(join(TEST_DIR, 'node_modules', 'ms'), nested, {recursive: true});

    const result = run('retarget outer/node_modules/ms', TEST_DIR);

    expect(result.exitCode).toBe(0);
    expect(readdirSync(join(TEST_DIR, 'patches'))).toEqual(['outer++ms+2.1.3.patch']);
  });
});

// Опции, которые есть у patch-package и которых у нас не было: свой каталог
// патчей, фильтры путей при создании, строгий код возврата на предупреждении,
// снятие всех патчей разом и несколько пакетов за один вызов.
describe('command-line options', () => {
  const PATCH = `--- a/node_modules/test-lib/index.js
+++ b/node_modules/test-lib/index.js
@@ -1 +1 @@
-const a = 1;
+const a = 2;
`;

  test('--patch-dir puts patches somewhere else, and finds them there', () => {
    setupFakePackage(TEST_DIR, 'test-lib', '1.0.0', {'index.js': 'const a = 1;\n'});
    mkdirSync(join(TEST_DIR, 'vendor-patches'), {recursive: true});
    writeFileSync(join(TEST_DIR, 'vendor-patches', 'test-lib+1.0.0.patch'), PATCH);

    // Каталог по умолчанию пуст, так что без флага применять нечего.
    expect(run('apply', TEST_DIR).stdout).toContain('No patches directory found');

    const applied = run('apply --patch-dir vendor-patches', TEST_DIR);
    expect(applied.exitCode).toBe(0);
    expect(readFileSync(join(TEST_DIR, 'node_modules', 'test-lib', 'index.js'), 'utf-8')).toBe('const a = 2;\n');

    const status = run('status --patch-dir vendor-patches', TEST_DIR);
    expect(status.exitCode).toBe(0);
    expect(status.stdout).toContain('vendor-patches/');
  });

  test('--patch-dir refuses a directory outside the project', () => {
    const result = run('apply --patch-dir ../elsewhere', TEST_DIR);

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toContain('outside the project');
  });

  test('--exclude leaves paths out of a new patch, --include keeps only some', () => {
    execSync('bun add ms@2.1.2', {cwd: TEST_DIR, stdio: 'pipe'});
    const pkg = join(TEST_DIR, 'node_modules', 'ms');
    overwriteFile(join(pkg, 'index.js'), `// INDEX FIX\n${readFileSync(join(pkg, 'index.js'), 'utf-8')}`);
    overwriteFile(join(pkg, 'license.md'), `// LICENSE FIX\n${readFileSync(join(pkg, 'license.md'), 'utf-8')}`);

    const excluded = run('create ms --exclude license', TEST_DIR);
    expect(excluded.exitCode).toBe(0);
    expect(excluded.stdout).toContain('left out by --include/--exclude');
    let patch = readFileSync(join(TEST_DIR, 'patches', 'ms+2.1.2.patch'), 'utf-8');
    expect(patch).toContain('INDEX FIX');
    expect(patch).not.toContain('LICENSE FIX');

    rmSync(join(TEST_DIR, 'patches'), {force: true, recursive: true});

    expect(run('create ms --include license', TEST_DIR).exitCode).toBe(0);
    patch = readFileSync(join(TEST_DIR, 'patches', 'ms+2.1.2.patch'), 'utf-8');
    expect(patch).toContain('LICENSE FIX');
    expect(patch).not.toContain('INDEX FIX');
  });

  test('path filters ignore case until --case-sensitive-path-filtering says otherwise', () => {
    execSync('bun add ms@2.1.2', {cwd: TEST_DIR, stdio: 'pipe'});
    const pkg = join(TEST_DIR, 'node_modules', 'ms');
    overwriteFile(join(pkg, 'license.md'), `// LICENSE FIX\n${readFileSync(join(pkg, 'license.md'), 'utf-8')}`);

    // Файл называется license.md, шаблон — LICENSE: без флага регистр не важен,
    // и отсеивается всё, что менялось.
    expect(run('create ms --exclude LICENSE', TEST_DIR).stdout).toContain(
      'Everything that changed was left out by --include/--exclude',
    );

    const sensitive = run('create ms --exclude LICENSE --case-sensitive-path-filtering', TEST_DIR);
    expect(sensitive.exitCode).toBe(0);
    expect(readFileSync(join(TEST_DIR, 'patches', 'ms+2.1.2.patch'), 'utf-8')).toContain('LICENSE FIX');
  });

  test('--error-on-warn turns a version mismatch into a failed install', () => {
    setupFakePackage(TEST_DIR, 'test-lib', '2.0.0', {'index.js': 'const a = 1;\n'});
    mkdirSync(join(TEST_DIR, 'patches'), {recursive: true});
    writeFileSync(join(TEST_DIR, 'patches', 'test-lib+1.0.0.patch'), PATCH);

    const quiet = run('apply', TEST_DIR);
    expect(quiet.stdout).toContain('version mismatch');
    // Патч лёг: расхождение версии само по себе установку не валит.
    expect(quiet.exitCode).toBe(0);

    // Второй прогон предупреждает так же, а патч уже в дереве.
    const strict = run('apply --error-on-warn', TEST_DIR);
    expect(strict.stdout).toContain('version mismatch');
    expect(strict.exitCode).toBe(1);
  });

  test('reverse takes every patch back out', () => {
    setupFakePackage(TEST_DIR, 'test-lib', '1.0.0', {'index.js': 'const a = 1;\n'});
    setupFakePackage(TEST_DIR, 'other-lib', '1.0.0', {'index.js': 'const b = 1;\n'});
    mkdirSync(join(TEST_DIR, 'patches'), {recursive: true});
    writeFileSync(join(TEST_DIR, 'patches', 'test-lib+1.0.0.patch'), PATCH);
    writeFileSync(join(TEST_DIR, 'patches', 'other-lib+1.0.0.patch'), `--- a/node_modules/other-lib/index.js
+++ b/node_modules/other-lib/index.js
@@ -1 +1 @@
-const b = 1;
+const b = 2;
`);
    expect(run('apply', TEST_DIR).exitCode).toBe(0);

    const result = run('reverse', TEST_DIR);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('2 of 2 un-applied');
    expect(readFileSync(join(TEST_DIR, 'node_modules', 'test-lib', 'index.js'), 'utf-8')).toBe('const a = 1;\n');
    expect(readFileSync(join(TEST_DIR, 'node_modules', 'other-lib', 'index.js'), 'utf-8')).toBe('const b = 1;\n');
    // Запись о применённом больше ничего не утверждает.
    const state = JSON.parse(readFileSync(join(TEST_DIR, 'node_modules', '.bunch-package-state.json'), 'utf-8'));
    expect(state.patches).toEqual([]);
  });

  test('create takes several packages, and one failure does not cancel the rest', () => {
    execSync('bun add ms@2.1.2 is-number@7.0.0', {cwd: TEST_DIR, stdio: 'pipe'});
    for (const name of ['ms', 'is-number']) {
      const file = join(TEST_DIR, 'node_modules', name, 'index.js');
      overwriteFile(file, `// FIX ${name}\n${readFileSync(file, 'utf-8')}`);
    }

    const result = run('create ms nonexistent-package is-number', TEST_DIR);

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toContain('nonexistent-package not found');
    expect(readdirSync(join(TEST_DIR, 'patches')).sort()).toEqual(['is-number+7.0.0.patch', 'ms+2.1.2.patch']);
  });

  test('refuses an option it does not know instead of ignoring it', () => {
    const result = run('apply --exclud license', TEST_DIR);

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toContain('Unknown option: --exclud');
  });
});

// Пакет из devDependencies на production-установке не ставится вовсе, и патч
// для него не должен валить деплой. Соглашение то же, что у patch-package:
// суффикс `.dev.patch` в имени файла.
describe('dev-only patches', () => {
  const PATCH = `--- a/node_modules/test-lib/index.js
+++ b/node_modules/test-lib/index.js
@@ -1 +1 @@
-const a = 1;
+const a = 2;
`;

  function patchWithoutPackage(file: string) {
    mkdirSync(join(TEST_DIR, 'node_modules'), {recursive: true});
    mkdirSync(join(TEST_DIR, 'patches'), {recursive: true});
    writeFileSync(join(TEST_DIR, 'patches', file), PATCH);
  }

  test('apply skips one in production when its package is absent', () => {
    patchWithoutPackage('test-lib+1.0.0.dev.patch');

    const result = run('apply', TEST_DIR, {NODE_ENV: 'production'});

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('dev-only');
    expect(result.stdout).toContain('0 applied, 0 failed');
  });

  test('apply still refuses it outside production — the package should be there', () => {
    patchWithoutPackage('test-lib+1.0.0.dev.patch');

    const result = run('apply', TEST_DIR);

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toContain('node_modules/test-lib is not installed');
  });

  test('applies normally when the package is installed', () => {
    setupFakePackage(TEST_DIR, 'test-lib', '1.0.0', {'index.js': 'const a = 1;\n'});
    mkdirSync(join(TEST_DIR, 'patches'), {recursive: true});
    writeFileSync(join(TEST_DIR, 'patches', 'test-lib+1.0.0.dev.patch'), PATCH);

    const result = run('apply', TEST_DIR, {NODE_ENV: 'production'});

    expect(result.exitCode).toBe(0);
    expect(readFileSync(join(TEST_DIR, 'node_modules', 'test-lib', 'index.js'), 'utf-8')).toBe('const a = 2;\n');
  });

  test('in production, a devDependency counts even without the suffix', () => {
    writeFileSync(
      join(TEST_DIR, 'package.json'),
      JSON.stringify({name: 'test-project', version: '1.0.0', devDependencies: {'test-lib': '1.0.0'}}),
    );
    patchWithoutPackage('test-lib+1.0.0.patch');

    const result = run('apply', TEST_DIR, {NODE_ENV: 'production'});

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('dev-only');
  });

  test('names the way out when a missing package is not marked dev', () => {
    patchWithoutPackage('test-lib+1.0.0.patch');

    const result = run('apply', TEST_DIR, {NODE_ENV: 'production'});

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toContain('rename this patch to test-lib+1.0.0.dev.patch');
  });

  test('status leaves it out of the count instead of calling it missing', () => {
    patchWithoutPackage('test-lib+1.0.0.dev.patch');

    const result = run('status', TEST_DIR, {NODE_ENV: 'production'});

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('dev-only');
    expect(result.stdout).not.toContain('of 1 in the tree');
  });

  test('create --dev marks the patch, and the next one in the sequence keeps the mark', () => {
    execSync('bun add ms@2.1.2', {cwd: TEST_DIR, stdio: 'pipe'});
    const file = join(TEST_DIR, 'node_modules', 'ms', 'index.js');
    overwriteFile(file, `// FIRST\n${readFileSync(file, 'utf-8')}`);

    expect(run('create ms --dev', TEST_DIR).exitCode).toBe(0);
    expect(readdirSync(join(TEST_DIR, 'patches'))).toEqual(['ms+2.1.2.dev.patch']);

    overwriteFile(file, `${readFileSync(file, 'utf-8')}\n// SECOND\n`);
    expect(run('create ms --append second', TEST_DIR).exitCode).toBe(0);

    // Метку наследует вся последовательность, и первый патч получает номер.
    expect(readdirSync(join(TEST_DIR, 'patches')).sort()).toEqual([
      'ms+2.1.2+001+initial.dev.patch',
      'ms+2.1.2+002+second.dev.patch',
    ]);
    // И каждый несёт только своё.
    const second = readFileSync(join(TEST_DIR, 'patches', 'ms+2.1.2+002+second.dev.patch'), 'utf-8');
    expect(second).toContain('+// SECOND');
    expect(second).not.toContain('FIRST');
  });
});

// Патч — единственный источник удалённых строк, а переводы строк в нём
// нормализуют по дороге и git, и веб-интерфейс GitHub. Поэтому при откате
// строку из патча приводим к тому переводу строки, каким живёт сам файл.
describe('line endings when un-applying', () => {
  function setup(fileText: string, patchText: string) {
    setupFakePackage(TEST_DIR, 'test-lib', '1.0.0', {'index.js': 'placeholder\n'});
    overwriteFile(join(TEST_DIR, 'node_modules', 'test-lib', 'index.js'), fileText);
    mkdirSync(join(TEST_DIR, 'patches'), {recursive: true});
    writeFileSync(join(TEST_DIR, 'patches', 'test-lib+1.0.0.patch'), patchText);
  }

  const file = () => readFileSync(join(TEST_DIR, 'node_modules', 'test-lib', 'index.js'), 'utf-8');

  const HEADER = `--- a/node_modules/test-lib/index.js
+++ b/node_modules/test-lib/index.js
`;

  test('gives a CRLF file its \\r back, when the patch had none', () => {
    const original = 'one\r\ntwo\r\nthree\r\n';
    // Патч в LF: ровно так его записал бы git с autocrlf или веб-редактор.
    setup(original, `${HEADER}@@ -1,3 +1,3 @@
 one
-two
+patched
 three
`);

    expect(run('apply', TEST_DIR).exitCode).toBe(0);
    expect(file()).toContain('patched');
    expect(run('rebase test-lib 0', TEST_DIR).exitCode).toBe(0);

    expect(file()).toBe(original);
  });

  test('does not bring \\r into an LF file, when the patch is CRLF', () => {
    const original = 'one\ntwo\nthree\n';
    // Патч целиком в CRLF — такой в корпусе тоже нашёлся.
    setup(original, `--- a/node_modules/test-lib/index.js\r
+++ b/node_modules/test-lib/index.js\r
@@ -1,3 +1,3 @@\r
 one\r
-two\r
+patched\r
 three\r
`);

    expect(run('apply', TEST_DIR).exitCode).toBe(0);
    expect(run('rebase test-lib 0', TEST_DIR).exitCode).toBe(0);

    expect(file()).toBe(original);
  });

  test('leaves a mixed file the way the neighbours of the hunk are', () => {
    // Первые строки в CRLF, хвост в LF. Хунк трогает CRLF-часть.
    const original = 'one\r\ntwo\r\nthree\r\nfour\nfive\n';
    setup(original, `${HEADER}@@ -1,3 +1,3 @@
 one
-two
+patched
 three
`);

    expect(run('apply', TEST_DIR).exitCode).toBe(0);
    expect(run('rebase test-lib 0', TEST_DIR).exitCode).toBe(0);

    expect(file()).toBe(original);
  });
});

describe('CLI usage', () => {
  test('shows help with no arguments', () => {
    const result = run('', TEST_DIR);
    expect(result.stdout).toContain('bunch-package');
    expect(result.stdout).toContain('create');
    expect(result.stdout).toContain('apply');
  });

  test('shows error when create without package name', () => {
    const result = run('create', TEST_DIR);
    expect(result.exitCode).not.toBe(0);
  });
});

// Симлинки не переносятся патчем вовсе: формат возит содержимое файлов, а
// ссылку в нём записать нечем. Опасность не в этом, а в тишине — правка
// молча пропадала, а на Linux вдобавок уносила с собой весь патч.
describe('symbolic links', () => {
  function scanFixture(files: Record<string, string>, links: Record<string, string>) {
    const root = join(TEST_DIR, `tree-${Object.keys(files).length}-${Object.keys(links).join('-')}`);
    mkdirSync(root, {recursive: true});
    for (const [name, content] of Object.entries(files)) writeFileSync(join(root, name), content);
    for (const [name, target] of Object.entries(links)) symlinkSync(target, join(root, name));
    return scanTree(root);
  }

  test.skipIf(isWindows)('sees every way a link can differ', () => {
    const clean = scanFixture(
      {'became-link.js': 'x\n', 'kept.js': 'x\n'},
      {retargeted: 'one.js', removed: 'gone.js', 'became-file': 'real.js', same: 'real.js'},
    );
    const modified = scanFixture(
      {'became-file': 'x\n', 'kept.js': 'x\n'},
      {retargeted: 'two.js', added: 'new.js', 'became-link.js': 'real.js', same: 'real.js'},
    );

    const differences = findLinkDifferences(clean, modified);
    const byPath = new Map(differences.map(d => [d.relativePath, d]));

    // Одинаковая ссылка и обычный файл в списке не нужны.
    expect([...byPath.keys()].sort()).toEqual([
      'added',
      'became-file',
      'became-link.js',
      'removed',
      'retargeted',
    ]);

    expect(byPath.get('added')!.change).toBe('added');
    expect(byPath.get('removed')!.change).toBe('removed');
    expect(byPath.get('retargeted')!.change).toContain('two.js');
    expect(byPath.get('became-file')!.change).toContain('regular file');
    expect(byPath.get('became-link.js')!.change).toContain('symlink');

    // missingFrom называет дерево, где пути нет вовсе: на таком сочетании GNU
    // diff отказывается работать, и только по этому списку код возврата 2
    // отличается от настоящего сбоя.
    expect(byPath.get('added')!.missingFrom).toBe('clean');
    expect(byPath.get('removed')!.missingFrom).toBe('modified');
    expect(byPath.get('retargeted')!.missingFrom).toBe(null);
    expect(byPath.get('became-file')!.missingFrom).toBe(null);
  });

  test.skipIf(isWindows)('create says a link changed instead of claiming nothing did', () => {
    execSync('bun add is-number@7.0.0', {cwd: TEST_DIR, stdio: 'pipe'});
    symlinkSync('index.js', join(TEST_DIR, 'node_modules', 'is-number', 'alias.js'));

    const result = run('create is-number', TEST_DIR);

    expect(result.stdout).toContain('symbolic link');
    expect(result.stdout).toContain('alias.js');
    // Раньше здесь было «No changes detected» — то есть неправда.
    expect(result.stdout).not.toContain('No changes detected');
    expect(existsSync(join(TEST_DIR, 'patches'))).toBe(false);
  });

  test.skipIf(isWindows)('create keeps the file changes a new link used to take down', () => {
    execSync('bun add is-number@7.0.0', {cwd: TEST_DIR, stdio: 'pipe'});
    const pkg = join(TEST_DIR, 'node_modules', 'is-number');
    symlinkSync('index.js', join(pkg, 'alias.js'));
    overwriteFile(join(pkg, 'index.js'), 'module.exports = "patched";\n');

    const result = run('create is-number', TEST_DIR);

    // GNU diff (в отличие от Apple) выходит с кодом 2, когда с одной стороны
    // симлинк, а с другой нет ничего. Код тот же, что у настоящего сбоя,
    // поэтому один добавленный симлинк отменял весь патч целиком.
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('symbolic link');

    const patch = readFileSync(join(TEST_DIR, 'patches', 'is-number+7.0.0.patch'), 'utf-8');
    expect(patch).toContain('+module.exports = "patched";');
    expect(patch).not.toContain('alias.js');
  });

  test('apply refuses a patch that creates a symbolic link', () => {
    setupFakePackage(TEST_DIR, 'test-lib', '1.0.0', {'real.js': 'hello\n'});

    mkdirSync(join(TEST_DIR, 'patches'), {recursive: true});
    // Так симлинк записывает git: режим 120000, содержимое — цель ссылки.
    const patchContent = `diff --git a/node_modules/test-lib/link.js b/node_modules/test-lib/link.js
new file mode 120000
--- /dev/null
+++ b/node_modules/test-lib/link.js
@@ -0,0 +1 @@
+real.js
\\ No newline at end of file
`;
    writeFileSync(join(TEST_DIR, 'patches', 'test-lib+1.0.0.patch'), patchContent);

    const result = run('apply', TEST_DIR);

    // Молча положить сюда обычный файл со строкой `real.js` внутри — ровно то,
    // что делалось раньше, и рапортовалось это как успех.
    expect(result.stdout).toContain('0 applied, 1 failed');
    expect(result.stdout).toContain('symbolic link');
    expect(result.exitCode).not.toBe(0);
    expect(existsSync(join(TEST_DIR, 'node_modules', 'test-lib', 'link.js'))).toBe(false);
  });

  test('apply writes nothing at all when one section is a symbolic link', () => {
    setupFakePackage(TEST_DIR, 'test-lib', '1.0.0', {'one.js': 'const a = 1;\n'});

    mkdirSync(join(TEST_DIR, 'patches'), {recursive: true});
    const patchContent = `diff --git a/node_modules/test-lib/one.js b/node_modules/test-lib/one.js
--- a/node_modules/test-lib/one.js
+++ b/node_modules/test-lib/one.js
@@ -1 +1 @@
-const a = 1;
+const a = 2;
diff --git a/node_modules/test-lib/link.js b/node_modules/test-lib/link.js
new file mode 120000
--- /dev/null
+++ b/node_modules/test-lib/link.js
@@ -0,0 +1 @@
+one.js
\\ No newline at end of file
`;
    writeFileSync(join(TEST_DIR, 'patches', 'test-lib+1.0.0.patch'), patchContent);

    const result = run('apply', TEST_DIR);

    expect(result.stdout).toContain('0 applied, 1 failed');
    expect(readFileSync(join(TEST_DIR, 'node_modules', 'test-lib', 'one.js'), 'utf-8')).toBe('const a = 1;\n');
  });

  test.skipIf(isWindows)('apply refuses to turn a link on disk into a file', () => {
    setupFakePackage(TEST_DIR, 'test-lib', '1.0.0', {'real.js': 'hello\n'});
    const pkg = join(TEST_DIR, 'node_modules', 'test-lib');
    symlinkSync('real.js', join(pkg, 'link.js'));

    mkdirSync(join(TEST_DIR, 'patches'), {recursive: true});
    const patchContent = `--- a/node_modules/test-lib/link.js
+++ b/node_modules/test-lib/link.js
@@ -1 +1 @@
-hello
+patched
`;
    writeFileSync(join(TEST_DIR, 'patches', 'test-lib+1.0.0.patch'), patchContent);

    const result = run('apply', TEST_DIR);

    expect(result.stdout).toContain('0 applied, 1 failed');
    expect(result.stdout).toContain('symbolic link');
    // Ссылка на месте, и файл, на который она смотрит, не тронут.
    expect(lstatSync(join(pkg, 'link.js')).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(pkg, 'real.js'), 'utf-8')).toBe('hello\n');
  });
});

// Пределы, которые срабатывают только когда всё идёт плохо: буфер diff,
// таймаут установки эталона. Ни один из них не исполнялся ни разу — ни
// тестами, ни корпусным прогоном на 280 патчах, где всё ставится и всё влезает.
describe('limits and failure paths', () => {
  test('refuses a diff bigger than the buffer instead of truncating it', () => {
    const clean = join(TEST_DIR, 'clean');
    const modified = join(TEST_DIR, 'modified');
    mkdirSync(clean, {recursive: true});
    mkdirSync(modified, {recursive: true});

    let before = '';
    let after = '';
    for (let line = 0; line < 60_000; line++) {
      before += `line ${line}\n`;
      after += `LINE ${line}\n`;
    }
    writeFileSync(join(clean, 'big.js'), before);
    writeFileSync(join(modified, 'big.js'), after);

    // Превышение буфера bun отдаёт как ENOBUFS с усечённым stdout и status =
    // null. Принять такой вывод за нормальный значило бы записать обрезанный
    // патч — молча и с рапортом об успехе.
    expect(() => runDiff(clean, modified, 'big-pkg', '1.0.0', new Set(), 1024 * 1024)).toThrow(
      /larger than 1 MB/,
    );
  });

  test.skipIf(isWindows)('says the pristine fetch timed out, and how to allow longer', () => {
    setupFakePackage(TEST_DIR, 'test-lib', '1.0.0', {'index.js': 'const a = 1;\n'});

    // Оба способа добыть эталон подменяем на «висит и молчит». PATH задаётся
    // запускаемому процессу при старте, а не правкой process.env у текущего:
    // на bun 1.3.2 такая правка потомку вообще не доезжала без явного env, на
    // 1.4.0 доезжает — а через env работает на обеих.
    const fakeBin = join(TEST_DIR, 'bin');
    mkdirSync(fakeBin, {recursive: true});
    for (const name of ['bun', 'npm']) {
      const script = join(fakeBin, name);
      writeFileSync(script, '#!/bin/sh\nsleep 30\n');
      chmodSync(script, 0o755);
    }

    const result = run('create test-lib', TEST_DIR, {
      PATH: `${fakeBin}:${process.env.PATH}`,
      BUNCH_FETCH_TIMEOUT: '1',
    });

    // При таймауте bun не отдаёт ни stdout, ни stderr, поэтому раньше здесь
    // выходило `bun: spawnSync bun ETIMEDOUT` — предел выглядел чужим и
    // непреодолимым.
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toContain('timed out after 1s');
    expect(result.stdout).toContain('BUNCH_FETCH_TIMEOUT');
    // Оба пути названы: и bun, и запасной npm.
    expect(result.stdout).toContain('bun:');
    expect(result.stdout).toContain('npm:');
  });

  test('refuses a nonsense BUNCH_FETCH_TIMEOUT instead of quietly ignoring it', () => {
    setupFakePackage(TEST_DIR, 'test-lib', '1.0.0', {'index.js': 'const a = 1;\n'});

    const result = run('create test-lib', TEST_DIR, {BUNCH_FETCH_TIMEOUT: 'soon'});

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toContain('BUNCH_FETCH_TIMEOUT');
  });

  test('prints a failure as a line to read, not as a stack trace', () => {
    mkdirSync(join(TEST_DIR, 'node_modules'), {recursive: true});

    const result = run('create nonexistent-pkg', TEST_DIR);

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toContain('❌ Package nonexistent-pkg not found');
    // Текст сообщений писался для человека, а стек — это вид, в котором его
    // не читают.
    expect(result.stdout).not.toContain('at createPatch');
  });
});

// Два apply одновременно — postinstall на каждый `bun install`, воркспейсы
// монорепозитория, второй терминал. Измерено до замка: на сдвиге в 60 мс
// дерево осталось в состоянии, которого нет ни до, ни после — файлы,
// удалённые третьим патчем, воскресил сосед, применявший второй.
describe('two applies at once', () => {
  const PACKAGE = 'racy-lib';

  function lines(count: number, mark: string): string[] {
    return Array.from({length: count}, (_, index) => (index === 20 ? `${mark} marker` : `line ${index}`));
  }

  function replaceSection(file: string, before: string[], after: string[]): string {
    const path = `node_modules/${PACKAGE}/${file}`;
    return [
      `diff --git a/${path} b/${path}`,
      `--- a/${path}`,
      `+++ b/${path}`,
      `@@ -1,${before.length} +1,${after.length} @@`,
      ...before.map(line => `-${line}`),
      ...after.map(line => `+${line}`),
    ].join('\n');
  }

  function createSection(file: string, body: string[]): string {
    const path = `node_modules/${PACKAGE}/${file}`;
    return [
      `diff --git a/${path} b/${path}`,
      'new file mode 100644',
      '--- /dev/null',
      `+++ b/${path}`,
      `@@ -0,0 +1,${body.length} @@`,
      ...body.map(line => `+${line}`),
    ].join('\n');
  }

  function deleteSection(file: string, body: string[]): string {
    const path = `node_modules/${PACKAGE}/${file}`;
    return [
      `diff --git a/${path} b/${path}`,
      'deleted file mode 100644',
      `--- a/${path}`,
      '+++ /dev/null',
      `@@ -1,${body.length} +0,0 @@`,
      ...body.map(line => `-${line}`),
    ].join('\n');
  }

  const FILES = 120;
  const LENGTH = 60;
  const EXTRA = 10;
  const extraBody = ['made by the second patch'];

  // Три патча, как коммиты друг на друге: правка, правка плюс новые файлы,
  // правка плюс удаление половины новых. Удаление здесь и есть та операция,
  // на которой соседние процессы расходились: один сносил файл, другой
  // возвращал его, переприменяя предыдущий патч.
  function writeFixture() {
    const sources: Record<string, string> = {};
    for (let file = 0; file < FILES; file++) {
      sources[`f${file}.js`] = lines(LENGTH, 'original').join('\n');
    }
    setupFakePackage(TEST_DIR, PACKAGE, '1.0.0', sources);

    mkdirSync(join(TEST_DIR, 'patches'), {recursive: true});

    const first: string[] = [];
    const second: string[] = [];
    const third: string[] = [];

    for (let file = 0; file < FILES; file++) {
      first.push(replaceSection(`f${file}.js`, lines(LENGTH, 'original'), lines(LENGTH, 'first')));
      second.push(replaceSection(`f${file}.js`, lines(LENGTH, 'first'), lines(LENGTH, 'second')));
      third.push(replaceSection(`f${file}.js`, lines(LENGTH, 'second'), lines(LENGTH, 'third')));
    }
    for (let extra = 0; extra < EXTRA; extra++) {
      second.push(createSection(`new${extra}.js`, extraBody));
      if (extra % 2 === 0) third.push(deleteSection(`new${extra}.js`, extraBody));
    }

    const patches: Record<string, string> = {
      [`${PACKAGE}+1.0.0+001+one.patch`]: first.join('\n') + '\n',
      [`${PACKAGE}+1.0.0+002+two.patch`]: second.join('\n') + '\n',
      [`${PACKAGE}+1.0.0+003+three.patch`]: third.join('\n') + '\n',
    };
    for (const [name, content] of Object.entries(patches)) {
      writeFileSync(join(TEST_DIR, 'patches', name), content);
    }
  }

  function treeState(): string {
    const dir = join(TEST_DIR, 'node_modules', PACKAGE);
    return readdirSync(dir)
      .sort()
      .map(name => `${name}:${readFileSync(join(dir, name), 'utf-8').length}`)
      .join('|');
  }

  function applyInBackground(delayMs: number): Promise<number> {
    return new Promise(resolve => {
      setTimeout(() => {
        const child = spawn(process.execPath, [CLI, 'apply'], {cwd: TEST_DIR, stdio: 'ignore'});
        child.on('close', code => resolve(code ?? -1));
      }, delayMs);
    });
  }

  test('leave the same tree a single apply would, whatever the stagger', async () => {
    writeFixture();
    const startedAt = Date.now();
    run('apply', TEST_DIR);
    const single = Date.now() - startedAt;
    const expected = treeState();
    // Третий патч удаляет пять файлов, которые завёл второй: если их вернули,
    // это видно прямо здесь.
    expect(expected.split('|').filter(entry => entry.startsWith('new')).length).toBe(EXTRA / 2);

    // Сдвиги отмеряем долями одного прогона, а не абсолютными миллисекундами:
    // опасен тот сдвиг, что попадает внутрь чужой работы, а сколько она длится
    // — зависит от машины. С фиксированными числами тест ловил гонку в трети
    // случаев, то есть почти ничего не гарантировал.
    const staggers = [0, 0.2, 0.4, 0.6, 0.8].map(share => Math.round(single * share));

    for (const round of [1, 2]) {
      for (const stagger of staggers) {
        rmSync(join(TEST_DIR, 'node_modules'), {force: true, recursive: true});
        rmSync(join(TEST_DIR, 'patches'), {force: true, recursive: true});
        writeFixture();

        const codes = await Promise.all([applyInBackground(0), applyInBackground(stagger)]);

        expect(`round ${round} stagger ${stagger}: ${treeState()}`).toBe(`round ${round} stagger ${stagger}: ${expected}`);
        // И оба процесса считают, что всё на месте: второй ждал первого, а не
        // спотыкался о наполовину переписанные файлы.
        expect(codes).toEqual([0, 0]);
      }
    }
  });

  test('the second run waits rather than tramples, and says so if it cannot', () => {
    const lockFile = join(TEST_DIR, 'held.lock');

    // Замок держим сами и смотрим, что делает второй желающий.
    const outcome = withApplyLock(lockFile, () => {
      expect(existsSync(lockFile)).toBe(true);
      let refusal = '';
      try {
        withApplyLock(lockFile, () => 'должно было отказать', 200);
      } catch (error: any) {
        refusal = error.message;
      }
      return refusal;
    });

    expect(outcome).toContain('another `bunch-package apply` is running');
    expect(outcome).toContain(`pid ${process.pid}`);
    expect(outcome).toContain('delete it');
    // Свой замок снимается за собой.
    expect(existsSync(lockFile)).toBe(false);
  });

  test('releases the lock even when the run throws', () => {
    const lockFile = join(TEST_DIR, 'thrown.lock');

    expect(() =>
      withApplyLock(lockFile, () => {
        throw new Error('сорвалось');
      }),
    ).toThrow('сорвалось');

    // Иначе один сбой запирал бы проект навсегда.
    expect(existsSync(lockFile)).toBe(false);
    expect(withApplyLock(lockFile, () => 'снова свободен')).toBe('снова свободен');
  });
});

// Поведения, которые были описаны и закрыты, но ничем не закреплены: мутация
// снимает защиту, а сюита остаётся зелёной. Найдено прогоном мутаций по всем
// защитным веткам кода.
describe('behaviours nothing was checking', () => {
  test('refuses a creation patch when the file is already there with other content', () => {
    setupFakePackage(TEST_DIR, 'test-lib', '1.0.0', {'extra.js': 'written by someone else\n'});

    mkdirSync(join(TEST_DIR, 'patches'), {recursive: true});
    const patchContent = `diff --git a/node_modules/test-lib/extra.js b/node_modules/test-lib/extra.js
new file mode 100644
--- /dev/null
+++ b/node_modules/test-lib/extra.js
@@ -0,0 +1 @@
+created by the patch
`;
    writeFileSync(join(TEST_DIR, 'patches', 'test-lib+1.0.0.patch'), patchContent);

    const result = run('apply', TEST_DIR);

    // Без этой проверки чужой файл принимался за уже применённый патч: apply
    // рапортовал успех, а содержимое оставалось посторонним.
    expect(result.stdout).toContain('0 applied, 1 failed');
    expect(result.stdout).toContain('already exists');
    expect(result.exitCode).not.toBe(0);
    expect(readFileSync(join(TEST_DIR, 'node_modules', 'test-lib', 'extra.js'), 'utf-8')).toBe(
      'written by someone else\n',
    );
  });

  test('names the whole directory of a scoped package that is not installed', () => {
    mkdirSync(join(TEST_DIR, 'node_modules', '@ghost'), {recursive: true});
    mkdirSync(join(TEST_DIR, 'patches'), {recursive: true});
    const patchContent = `--- a/node_modules/@ghost/pkg/new.js
+++ b/node_modules/@ghost/pkg/new.js
@@ -0,0 +1 @@
+fabricated
`;
    writeFileSync(join(TEST_DIR, 'patches', '@ghost+pkg+1.0.0.patch'), patchContent);

    const result = run('apply', TEST_DIR);

    // Каталог скоупового пакета — три сегмента, а не два: @ghost сам по себе
    // пакетом не является, и говорить про него «not installed» бессмысленно.
    expect(result.stdout).toContain('node_modules/@ghost/pkg is not installed');
    expect(result.exitCode).not.toBe(0);
  });

  test('checks the version of a scoped package too', () => {
    setupFakePackage(TEST_DIR, '@scope/pkg', '2.0.0', {'index.js': 'const a = 1;\n'});

    mkdirSync(join(TEST_DIR, 'patches'), {recursive: true});
    const patchContent = `--- a/node_modules/@scope/pkg/index.js
+++ b/node_modules/@scope/pkg/index.js
@@ -1 +1 @@
-const a = 1;
+const a = 2;
`;
    // Патч сделан против 1.0.0, а стоит 2.0.0.
    writeFileSync(join(TEST_DIR, 'patches', '@scope+pkg+1.0.0.patch'), patchContent);

    const result = run('apply', TEST_DIR);

    // Манифест лежит в node_modules/@scope/pkg. Если считать каталогом пакета
    // node_modules/@scope, манифеста там нет — и проверка версии молча пропадает.
    expect(result.stdout).toContain('version mismatch');
    expect(result.stdout).toContain('patch: 1.0.0, installed: 2.0.0');
  });

  test('refuses a package whose manifest carries an unusable version', () => {
    // name и version приходят из чужого package.json и попадают прямо в путь,
    // по которому пишется патч.
    const pkgDir = join(TEST_DIR, 'node_modules', 'test-lib');
    mkdirSync(pkgDir, {recursive: true});
    writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({name: 'test-lib', version: '../../../escaped'}));
    writeFileSync(join(pkgDir, 'index.js'), 'const a = 1;\n');

    const result = run('create test-lib', TEST_DIR);

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toContain('unusable version');
    // До сети дело дойти не должно вовсе.
    expect(result.stdout).not.toContain('Fetching pristine');
    expect(existsSync(join(TEST_DIR, 'patches'))).toBe(false);
  });
});

// Записывать файл на месте — значит держать окно, в котором его нет вовсе или
// он обрезан. Убитый там apply оставлял дерево в состоянии, из которого патч
// больше не ложился никогда: хунк не сходится с пустотой.
describe('an apply killed mid-write', () => {
  const PACKAGE = 'torn-lib';
  const FILES = 100;
  const LINES = 3000; // ~140 КБ на файл: чем длиннее запись, тем вероятнее попасть в неё

  const body = (file: number, mark: string) =>
    Array.from({length: LINES}, (_, line) => `file ${file} line ${line} ${mark} padding padding padding`).join('\n') + '\n';

  function writeFixture() {
    const sources: Record<string, string> = {};
    for (let file = 0; file < FILES; file++) sources[`f${file}.js`] = body(file, 'original');
    setupFakePackage(TEST_DIR, PACKAGE, '1.0.0', sources);

    const sections: string[] = [];
    for (let file = 0; file < FILES; file++) {
      const path = `node_modules/${PACKAGE}/f${file}.js`;
      sections.push([
        `diff --git a/${path} b/${path}`,
        `--- a/${path}`,
        `+++ b/${path}`,
        `@@ -1,${LINES} +1,${LINES} @@`,
        ...body(file, 'original').trimEnd().split('\n').map(line => `-${line}`),
        ...body(file, 'PATCHED').trimEnd().split('\n').map(line => `+${line}`),
      ].join('\n'));
    }
    mkdirSync(join(TEST_DIR, 'patches'), {recursive: true});
    writeFileSync(join(TEST_DIR, 'patches', `${PACKAGE}+1.0.0.patch`), sections.join('\n') + '\n');
  }

  // Убиваем не по таймеру, а по признаку: как только первый файл перестал быть
  // прежним, фаза записи идёт прямо сейчас. Следим за размером и инодом, а не за
  // содержимым, и крутимся через setImmediate, а не по таймеру: у setInterval
  // шаг в миллисекунду, а вся фаза записи укладывается в десятки — с таким
  // шагом убийство опаздывало и тест ловил дефект лишь в трёх прогонах из шести.
  function applyAndKillOnFirstWrite(): Promise<void> {
    return new Promise(resolve => {
      // Следим за файлом из середины патча, а не за первым: убийство в самом
      // начале записи почти нечего застать в полёте, и тест ловил дефект лишь в
      // трети прогонов. К середине в очереди остаётся ещё сотня файлов.
      const middle = join(TEST_DIR, 'node_modules', PACKAGE, `f${Math.floor(FILES / 2)}.js`);
      const before = statSync(middle);
      const child = spawn(process.execPath, [CLI, 'apply'], {cwd: TEST_DIR, stdio: 'ignore'});

      let finished = false;
      const poll = () => {
        if (finished) return;
        let changed = false;
        try {
          const now = statSync(middle);
          changed = now.size !== before.size || now.ino !== before.ino;
        } catch {
          changed = true; // файла нет вовсе — это и есть то самое окно
        }
        if (changed) {
          child.kill('SIGKILL');
          return;
        }
        setImmediate(poll);
      };
      setImmediate(poll);

      child.on('close', () => {
        finished = true;
        resolve();
      });
    });
  }

  // Три круга, а не один: убийство может прийтись и на промежуток между
  // файлами, где рвать нечего. С одним кругом тест ловил запись на месте в шести
  // прогонах из восьми — то есть в CI был бы зелёным при сломанном коде каждый
  // четвёртый раз.
  test('leaves every file either untouched or fully patched, and stays fixable', async () => {
    for (const round of [1, 2, 3]) {
      rmSync(join(TEST_DIR, 'node_modules'), {force: true, recursive: true});
      rmSync(join(TEST_DIR, 'patches'), {force: true, recursive: true});
      writeFixture();

      await applyAndKillOnFirstWrite();

      const torn: string[] = [];
      for (let file = 0; file < FILES; file++) {
        const path = join(TEST_DIR, 'node_modules', PACKAGE, `f${file}.js`);
        if (!existsSync(path)) {
          torn.push(`f${file}.js исчез`);
          continue;
        }
        const text = readFileSync(path, 'utf-8');
        if (text !== body(file, 'original') && text !== body(file, 'PATCHED')) {
          torn.push(`f${file}.js обрезан на ${text.length} байт`);
        }
      }
      expect(`round ${round}: ${torn.join(', ')}`).toBe(`round ${round}: `);

      // И главное: из оставшегося состояния патч обязан лечь. Обрезанный файл
      // делал проект непочинимым — каждый следующий apply падал на нём, и
      // замок убитого прогона держал дверь ещё тридцать секунд сверху.
      const result = run('apply', TEST_DIR);
      expect(`round ${round}: ${result.stdout.includes('1 applied, 0 failed')}`).toBe(`round ${round}: true`);
      expect(result.exitCode).toBe(0);
      for (let file = 0; file < FILES; file++) {
        expect(readFileSync(join(TEST_DIR, 'node_modules', PACKAGE, `f${file}.js`), 'utf-8')).toBe(body(file, 'PATCHED'));
      }
    }
  });

  test('leaves no temporary files behind when it finishes', () => {
    setupFakePackage(TEST_DIR, 'test-lib', '1.0.0', {'index.js': 'const a = 1;\n'});
    mkdirSync(join(TEST_DIR, 'patches'), {recursive: true});
    writeFileSync(join(TEST_DIR, 'patches', 'test-lib+1.0.0.patch'), `--- a/node_modules/test-lib/index.js
+++ b/node_modules/test-lib/index.js
@@ -1 +1 @@
-const a = 1;
+const a = 2;
`);

    expect(run('apply', TEST_DIR).exitCode).toBe(0);

    const leftovers = readdirSync(join(TEST_DIR, 'node_modules', 'test-lib')).filter(name => name.includes('.bunch-tmp-'));
    expect(leftovers).toEqual([]);
  });

  test('writes past a hardlink instead of through it', () => {
    // Ровно то, как bun раскладывает пакеты: файл в node_modules и запись в
    // кеше — один инод. Запись на месте изменила бы и кеш.
    setupFakePackage(TEST_DIR, 'test-lib', '1.0.0', {'index.js': 'const a = 1;\n'});
    const patched = join(TEST_DIR, 'node_modules', 'test-lib', 'index.js');
    const cacheEntry = join(TEST_DIR, 'cache-entry.js');
    linkSync(patched, cacheEntry);
    expect(statSync(cacheEntry).ino).toBe(statSync(patched).ino);

    mkdirSync(join(TEST_DIR, 'patches'), {recursive: true});
    writeFileSync(join(TEST_DIR, 'patches', 'test-lib+1.0.0.patch'), `--- a/node_modules/test-lib/index.js
+++ b/node_modules/test-lib/index.js
@@ -1 +1 @@
-const a = 1;
+const a = 2;
`);

    expect(run('apply', TEST_DIR).exitCode).toBe(0);

    expect(readFileSync(patched, 'utf-8')).toBe('const a = 2;\n');
    expect(readFileSync(cacheEntry, 'utf-8')).toBe('const a = 1;\n');
    expect(statSync(cacheEntry).ino).not.toBe(statSync(patched).ino);
  });

  test('takes over a lock whose holder is gone', () => {
    const lockFile = join(TEST_DIR, 'stale.lock');

    // pid завершившегося процесса: spawnSync возвращается уже после его смерти.
    const gonePid = spawnSync(process.execPath, ['-e', ''], {stdio: 'ignore'}).pid;
    writeFileSync(lockFile, `${gonePid}\n`);

    const startedAt = Date.now();
    // Ждать здесь нечего и некого — замок ничей. Ожидание в 30 секунд означало
    // бы, что убитый однажды apply запер проект до ручной уборки.
    expect(withApplyLock(lockFile, () => 'занял', 30_000)).toBe('занял');
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(existsSync(lockFile)).toBe(false);
  });

  test('keeps a leftover temporary file out of the next patch', () => {
    execSync('bun add is-number@7.0.0', {cwd: TEST_DIR, stdio: 'pipe'});
    const pkg = join(TEST_DIR, 'node_modules', 'is-number');
    overwriteFile(join(pkg, 'index.js'), 'module.exports = "patched";\n');
    // След убитого apply: файл, который он не успел переставить на место.
    writeFileSync(join(pkg, 'index.js.bunch-tmp-4242'), 'half-written\n');

    const result = run('create is-number', TEST_DIR);

    expect(result.exitCode).toBe(0);
    const patch = readFileSync(join(TEST_DIR, 'patches', 'is-number+7.0.0.patch'), 'utf-8');
    expect(patch).toContain('+module.exports = "patched";');
    // Иначе чужой обрывок уехал бы в патч и лёг бы на машины всей команды.
    expect(patch).not.toContain('bunch-tmp');
  });

  test('waits for a lock whose holder is alive', () => {
    const lockFile = join(TEST_DIR, 'alive.lock');
    // Свой же pid — процесс заведомо жив, значит замок трогать нельзя.
    writeFileSync(lockFile, `${process.pid}\n`);

    expect(() => withApplyLock(lockFile, () => 'не должно занять', 200)).toThrow(/is running/);
    expect(readFileSync(lockFile, 'utf-8').trim()).toBe(String(process.pid));
  });
});

// Запись о применённых патчах и команда, которая отвечает на вопрос «что
// сейчас в дереве». Запись — только запись: доказательство берётся из дерева.
// Запись о применённых патчах и команда, которая отвечает на вопрос «что
// сейчас в дереве». Запись — только запись: доказательство берётся из дерева.
describe('state file and status', () => {
  const PATCH = `--- a/node_modules/test-lib/index.js
+++ b/node_modules/test-lib/index.js
@@ -1 +1 @@
-const a = 1;
+const a = 2;
`;

  function setupPatched() {
    setupFakePackage(TEST_DIR, 'test-lib', '1.0.0', {'index.js': 'const a = 1;\n'});
    mkdirSync(join(TEST_DIR, 'patches'), {recursive: true});
    writeFileSync(join(TEST_DIR, 'patches', 'test-lib+1.0.0.patch'), PATCH);
  }

  function readStateFile(): any {
    return JSON.parse(readFileSync(join(TEST_DIR, 'node_modules', '.bunch-package-state.json'), 'utf-8'));
  }

  test('apply records what ended up in the tree', () => {
    setupPatched();
    expect(run('apply', TEST_DIR).exitCode).toBe(0);

    const state = readStateFile();
    expect(state.version).toBe(1);
    expect(state.patches).toHaveLength(1);
    expect(state.patches[0].file).toBe('test-lib+1.0.0.patch');
    expect(state.patches[0].packageDir).toBe('test-lib');
    expect(state.patches[0].version).toBe('1.0.0');
    expect(state.patches[0].sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(Number.isNaN(Date.parse(state.patches[0].appliedAt))).toBe(false);
  });

  test('keeps the original time until the patch file itself changes', () => {
    setupPatched();
    run('apply', TEST_DIR);
    const first = readStateFile().patches[0].appliedAt;

    run('apply', TEST_DIR);
    // Иначе `appliedAt` означал бы «когда последний раз запускали apply».
    expect(readStateFile().patches[0].appliedAt).toBe(first);

    // А вот другой патч под тем же именем — уже другое событие.
    overwriteFile(join(TEST_DIR, 'node_modules', 'test-lib', 'index.js'), 'const a = 1;\n');
    writeFileSync(join(TEST_DIR, 'patches', 'test-lib+1.0.0.patch'), PATCH.replace('+const a = 2;', '+const a = 3;'));
    run('apply', TEST_DIR);
    expect(readStateFile().patches[0].appliedAt).not.toBe(first);
  });

  test('status says a patch is in the tree, and exits 0', () => {
    setupPatched();
    run('apply', TEST_DIR);

    const result = run('status', TEST_DIR);
    expect(result.stdout).toContain('✅ test-lib+1.0.0.patch — in the tree');
    expect(result.stdout).toContain('1 of 1 in the tree');
    expect(result.exitCode).toBe(0);
  });

  test('status says a patch left the tree, and exits 1', () => {
    setupPatched();
    run('apply', TEST_DIR);
    // Так выглядит переустановка node_modules: правка ушла, запись осталась.
    overwriteFile(join(TEST_DIR, 'node_modules', 'test-lib', 'index.js'), 'const a = 1;\n');

    const result = run('status', TEST_DIR);
    expect(result.stdout).toContain('⬜ test-lib+1.0.0.patch — not in the tree');
    expect(result.stdout).toContain('0 of 1 in the tree');
    expect(result.exitCode).not.toBe(0);
  });

  test('status says when a patch no longer fits at all', () => {
    setupPatched();
    run('apply', TEST_DIR);
    overwriteFile(join(TEST_DIR, 'node_modules', 'test-lib', 'index.js'), 'something else entirely\n');

    const result = run('status', TEST_DIR);
    expect(result.stdout).toContain('❌ test-lib+1.0.0.patch — does not fit the tree');
    expect(result.stdout).toContain('does not fit');
    expect(result.exitCode).not.toBe(0);
  });

  test('status reports a recorded patch whose file is gone', () => {
    setupPatched();
    run('apply', TEST_DIR);
    rmSync(join(TEST_DIR, 'patches', 'test-lib+1.0.0.patch'));

    // Файл удалили, а правка осталась в node_modules — промолчать об этом
    // значило бы ответить неправду на вопрос «что сейчас в дереве».
    const result = run('status', TEST_DIR);
    expect(result.stdout).toContain('no longer exist');
    expect(result.stdout).toContain('test-lib+1.0.0.patch');
    expect(result.exitCode).not.toBe(0);
  });

  test('status notices that the patch file changed after it was applied', () => {
    setupPatched();
    run('apply', TEST_DIR);
    // Патч отредактировали, но дерево осталось прежним.
    writeFileSync(join(TEST_DIR, 'patches', 'test-lib+1.0.0.patch'), PATCH + '\n');

    const result = run('status', TEST_DIR);
    expect(result.stdout).toContain('changed since it was applied');
  });

  test('a corrupt state file does not stop apply', () => {
    setupPatched();
    mkdirSync(join(TEST_DIR, 'node_modules'), {recursive: true});
    writeFileSync(join(TEST_DIR, 'node_modules', '.bunch-package-state.json'), '{ not json at all');

    // Запись — не источник истины, и ронять из-за неё прогон нельзя.
    const result = run('apply', TEST_DIR);
    expect(result.stdout).toContain('1 applied, 0 failed');
    expect(result.exitCode).toBe(0);
    expect(readStateFile().patches).toHaveLength(1);
  });

  test('apply still succeeds when the state cannot be written', () => {
    setupPatched();
    // Каталог на месте файла: запись провалится, патч — нет.
    mkdirSync(join(TEST_DIR, 'node_modules', '.bunch-package-state.json'), {recursive: true});

    const result = run('apply', TEST_DIR);
    expect(result.stdout).toContain('could not write');
    expect(result.stdout).toContain('1 applied, 0 failed');
    expect(result.exitCode).toBe(0);
    expect(readFileSync(join(TEST_DIR, 'node_modules', 'test-lib', 'index.js'), 'utf-8')).toBe('const a = 2;\n');
  });

  test('status understands a sequence', () => {
    setupFakePackage(TEST_DIR, 'test-lib', '1.0.0', {'index.js': 'const a = 1;\n'});
    mkdirSync(join(TEST_DIR, 'patches'), {recursive: true});
    writeFileSync(join(TEST_DIR, 'patches', 'test-lib+1.0.0+001+one.patch'), PATCH);
    writeFileSync(join(TEST_DIR, 'patches', 'test-lib+1.0.0+002+two.patch'), `--- a/node_modules/test-lib/index.js
+++ b/node_modules/test-lib/index.js
@@ -1 +1 @@
-const a = 2;
+const a = 3;
`);
    run('apply', TEST_DIR);

    const result = run('status', TEST_DIR);
    // Патч из середины последовательности в одиночку не проверяется — его
    // «после» перестаёт существовать, как только сверху лёг следующий.
    expect(result.stdout).toContain('✅ test-lib+1.0.0+001+one.patch — in the tree');
    expect(result.stdout).toContain('✅ test-lib+1.0.0+002+two.patch — in the tree');
    expect(result.stdout).toContain('2 of 2 in the tree');
    expect(result.exitCode).toBe(0);
  });

  test('create ignores a state file left behind by patch-package', () => {
    execSync('bun add is-number@7.0.0', {cwd: TEST_DIR, stdio: 'pipe'});
    const pkg = join(TEST_DIR, 'node_modules', 'is-number');
    overwriteFile(join(pkg, 'index.js'), 'module.exports = "patched";\n');
    // patch-package кладёт эту запись прямо в каталог пакета — проверено
    // запуском его самого на последовательности из двух патчей.
    writeFileSync(join(pkg, '.patch-package.json'), '{"version":1,"patches":[],"isRebasing":false}');

    const result = run('create is-number', TEST_DIR);

    expect(result.exitCode).toBe(0);
    const patch = readFileSync(join(TEST_DIR, 'patches', 'is-number+7.0.0.patch'), 'utf-8');
    expect(patch).toContain('+module.exports = "patched";');
    expect(patch).not.toContain('patch-package.json');
  });
});

// Патчи одного пакета — как коммиты: чтобы переделать не последний, надо снять
// те, что легли поверх. Откат — это применение перевёрнутого патча тем же
// кодом, что и обычное применение.
describe('rebase', () => {
  const PKG = 'seq-lib';

  // Первый патч заменяет строку, второй **дописывает** — на дописывающем патче
  // и ломалась наивная проверка применённости у перевёрнутого патча.
  const ONE = `--- a/node_modules/${PKG}/index.js
+++ b/node_modules/${PKG}/index.js
@@ -1,3 +1,3 @@
-line one
+PATCH ONE
 line two
 line three
`;
  const TWO = `--- a/node_modules/${PKG}/index.js
+++ b/node_modules/${PKG}/index.js
@@ -1,3 +1,4 @@
 PATCH ONE
 line two
 line three
+PATCH TWO
`;

  function setupSequence() {
    setupFakePackage(TEST_DIR, PKG, '1.0.0', {'index.js': 'line one\nline two\nline three\n'});
    mkdirSync(join(TEST_DIR, 'patches'), {recursive: true});
    writeFileSync(join(TEST_DIR, 'patches', `${PKG}+1.0.0+001+one.patch`), ONE);
    writeFileSync(join(TEST_DIR, 'patches', `${PKG}+1.0.0+002+two.patch`), TWO);
    expect(run('apply', TEST_DIR).exitCode).toBe(0);
  }

  const content = () => readFileSync(join(TEST_DIR, 'node_modules', PKG, 'index.js'), 'utf-8');

  test('un-applies the patch that sits on top, keeping the one below', () => {
    setupSequence();
    expect(content()).toBe('PATCH ONE\nline two\nline three\nPATCH TWO\n');

    const result = run(`rebase ${PKG} 1`, TEST_DIR);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(`${PKG}+1.0.0+002+two.patch`);
    // Дописывающий патч снят, а не «признан отсутствующим»: прямое применение
    // такого патча сходится и во второй раз, поэтому спрашивать надо про
    // исходный патч, а не про перевёрнутый.
    expect(content()).toBe('PATCH ONE\nline two\nline three\n');
  });

  test('takes the target by number, label, number+label or file name', () => {
    for (const target of ['1', 'one', '001+one', `${PKG}+1.0.0+001+one.patch`]) {
      rmSync(join(TEST_DIR, 'node_modules'), {force: true, recursive: true});
      rmSync(join(TEST_DIR, 'patches'), {force: true, recursive: true});
      setupSequence();

      const result = run(`rebase ${PKG} ${target}`, TEST_DIR);

      expect(`${target}: ${result.exitCode}`).toBe(`${target}: 0`);
      expect(`${target}: ${content()}`).toBe(`${target}: PATCH ONE\nline two\nline three\n`);
    }
  });

  test('un-applies everything on 0', () => {
    setupSequence();

    const result = run(`rebase ${PKG} 0`, TEST_DIR);

    expect(result.exitCode).toBe(0);
    expect(content()).toBe('line one\nline two\nline three\n');
    // Вставлять патч перед остальными можно только через --append.
    expect(result.stdout).toContain('--append');
  });

  test('refuses an unknown target, listing what there is, and changes nothing', () => {
    setupSequence();
    const before = content();

    const result = run(`rebase ${PKG} 42`, TEST_DIR);

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toContain('Could not find patch 42');
    expect(result.stdout).toContain(`${PKG}+1.0.0+001+one.patch`);
    expect(content()).toBe(before);
  });

  test('says so instead of failing when there is nothing to un-apply', () => {
    setupSequence();
    run(`rebase ${PKG} 1`, TEST_DIR);

    const again = run(`rebase ${PKG} 1`, TEST_DIR);

    expect(again.exitCode).toBe(0);
    expect(again.stdout).toContain('was not in the tree');
    expect(content()).toBe('PATCH ONE\nline two\nline three\n');
  });

  test('brings back a file the patch deleted, and removes one it created', () => {
    setupFakePackage(TEST_DIR, PKG, '1.0.0', {'gone.js': 'delete me\n'});
    mkdirSync(join(TEST_DIR, 'patches'), {recursive: true});
    writeFileSync(join(TEST_DIR, 'patches', `${PKG}+1.0.0+001+one.patch`), `diff --git a/node_modules/${PKG}/gone.js b/node_modules/${PKG}/gone.js
deleted file mode 100644
--- a/node_modules/${PKG}/gone.js
+++ /dev/null
@@ -1 +0,0 @@
-delete me
diff --git a/node_modules/${PKG}/new.js b/node_modules/${PKG}/new.js
new file mode 100644
--- /dev/null
+++ b/node_modules/${PKG}/new.js
@@ -0,0 +1 @@
+made by the patch
`);
    expect(run('apply', TEST_DIR).exitCode).toBe(0);
    const pkgDir = join(TEST_DIR, 'node_modules', PKG);
    expect(existsSync(join(pkgDir, 'gone.js'))).toBe(false);
    expect(existsSync(join(pkgDir, 'new.js'))).toBe(true);

    expect(run(`rebase ${PKG} 0`, TEST_DIR).exitCode).toBe(0);

    expect(readFileSync(join(pkgDir, 'gone.js'), 'utf-8')).toBe('delete me\n');
    expect(existsSync(join(pkgDir, 'new.js'))).toBe(false);
  });

  test('refuses to un-apply a patch the tree no longer matches, and writes nothing', () => {
    setupSequence();
    // Кто-то поправил файл руками: ни одна сторона патча теперь не совпадает.
    overwriteFile(join(TEST_DIR, 'node_modules', PKG, 'index.js'), 'something else entirely\n');

    const result = run(`rebase ${PKG} 1`, TEST_DIR);

    expect(result.stdout).toContain('cannot be un-applied');
    expect(content()).toBe('something else entirely\n');
  });

  test('updates the record of what is in the tree', () => {
    setupSequence();
    const recorded = () =>
      JSON.parse(readFileSync(join(TEST_DIR, 'node_modules', '.bunch-package-state.json'), 'utf-8'))
        .patches.map((patch: any) => patch.file);
    expect(recorded()).toHaveLength(2);

    run(`rebase ${PKG} 1`, TEST_DIR);

    expect(recorded()).toEqual([`${PKG}+1.0.0+001+one.patch`]);
  });

  test('does not record a patch of another package that was never applied', () => {
    setupSequence();
    // Патч чужого пакета, который никто не применял: пакета нет вовсе, так что
    // и лечь ему некуда. Раньше запись после rebase собиралась из списка файлов
    // в patches/, и такой патч оказывался в ней как лежащий в дереве.
    writeFileSync(join(TEST_DIR, 'patches', 'other-lib+2.0.0.patch'), `--- a/node_modules/other-lib/index.js
+++ b/node_modules/other-lib/index.js
@@ -1 +1 @@
-const a = 1;
+const a = 2;
`);

    run(`rebase ${PKG} 1`, TEST_DIR);

    const recorded = JSON.parse(
      readFileSync(join(TEST_DIR, 'node_modules', '.bunch-package-state.json'), 'utf-8'),
    ).patches.map((patch: any) => patch.file);
    expect(recorded).toEqual([`${PKG}+1.0.0+001+one.patch`]);
  });

  test('create refuses when none of the sequence is in the tree', () => {
    setupSequence();
    run(`rebase ${PKG} 0`, TEST_DIR);

    // Раньше здесь молча переписывался последний патч: эталон доводился всеми
    // предыдущими, дерево их не содержало, и в патч уезжала отмена чужих правок.
    const result = run(`create ${PKG}`, TEST_DIR);

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toContain('None of the 2 patches');
    // И отказ случается до сети, а не после скачивания эталона.
    expect(result.stdout).not.toContain('Fetching pristine');
  });

  test('create updates the patch that was rebased onto, not the last one', () => {
    execSync('bun add is-number@7.0.0', {cwd: TEST_DIR, stdio: 'pipe'});
    const file = join(TEST_DIR, 'node_modules', 'is-number', 'index.js');

    overwriteFile(file, readFileSync(file, 'utf-8').replace("'use strict';", "'use strict';\n// FIRST"));
    run('create is-number', TEST_DIR);
    overwriteFile(file, readFileSync(file, 'utf-8') + '\n// SECOND\n');
    run('create is-number --append two', TEST_DIR);
    run('apply', TEST_DIR);

    expect(run('rebase is-number 1', TEST_DIR).exitCode).toBe(0);
    expect(readFileSync(file, 'utf-8')).not.toContain('// SECOND');

    // Правим то, что делал первый патч, — и create обязан переписать именно его.
    overwriteFile(file, readFileSync(file, 'utf-8').replace('// FIRST', '// FIRST, EDITED'));
    const created = run('create is-number', TEST_DIR);
    expect(created.exitCode).toBe(0);

    const first = readFileSync(join(TEST_DIR, 'patches', 'is-number+7.0.0+001+initial.patch'), 'utf-8');
    const second = readFileSync(join(TEST_DIR, 'patches', 'is-number+7.0.0+002+two.patch'), 'utf-8');
    expect(first).toContain('// FIRST, EDITED');
    // Второй патч не тронут и по-прежнему делает только своё.
    expect(second).toContain('// SECOND');
    expect(second).not.toContain('EDITED');

    // И всё это вместе снова ложится.
    expect(run('apply', TEST_DIR).exitCode).toBe(0);
    expect(readFileSync(file, 'utf-8')).toContain('// FIRST, EDITED');
    expect(readFileSync(file, 'utf-8')).toContain('// SECOND');
  });

  test('restores a file that had no trailing newline', () => {
    // Патч не только меняет последнюю строку, но и дописывает файлу перевод
    // строки, которого у него не было. При откате этот байт обязан уйти
    // обратно — маркеры `\\ No newline` при инверсии меняются сторонами.
    setupFakePackage(TEST_DIR, PKG, '1.0.0', {'tail.js': 'line one\nlast line'});
    mkdirSync(join(TEST_DIR, 'patches'), {recursive: true});
    writeFileSync(join(TEST_DIR, 'patches', `${PKG}+1.0.0.patch`), `--- a/node_modules/${PKG}/tail.js
+++ b/node_modules/${PKG}/tail.js
@@ -1,2 +1,2 @@
 line one
-last line
\\ No newline at end of file
+patched last
`);

    expect(run('apply', TEST_DIR).exitCode).toBe(0);
    const file = join(TEST_DIR, 'node_modules', PKG, 'tail.js');
    expect(readFileSync(file, 'utf-8')).toBe('line one\npatched last\n');

    expect(run(`rebase ${PKG} 0`, TEST_DIR).exitCode).toBe(0);

    expect(readFileSync(file, 'utf-8')).toBe('line one\nlast line');
  });

  test('un-applies a patch whose two sides name different files', () => {
    // Так выглядит `diff index.js.bak index.js`: заголовков rename нет, правится
    // один файл — тот, что назван новой стороной. На корпусе это был случай,
    // где откат уходил в несуществующий файл и дерево не возвращалось назад.
    setupFakePackage(TEST_DIR, PKG, '1.0.0', {'index.js': 'line one\nline two\n'});
    mkdirSync(join(TEST_DIR, 'patches'), {recursive: true});
    writeFileSync(join(TEST_DIR, 'patches', `${PKG}+1.0.0.patch`), `diff --git a/node_modules/${PKG}/index.js.bak b/node_modules/${PKG}/index.js
--- a/node_modules/${PKG}/index.js.bak
+++ b/node_modules/${PKG}/index.js
@@ -1,2 +1,2 @@
-line one
+PATCHED
 line two
`);

    expect(run('apply', TEST_DIR).exitCode).toBe(0);
    const file = join(TEST_DIR, 'node_modules', PKG, 'index.js');
    expect(readFileSync(file, 'utf-8')).toBe('PATCHED\nline two\n');

    const result = run(`rebase ${PKG} 0`, TEST_DIR);

    expect(result.exitCode).toBe(0);
    expect(readFileSync(file, 'utf-8')).toBe('line one\nline two\n');
    // И никакого .bak на диске не появилось.
    expect(existsSync(join(TEST_DIR, 'node_modules', PKG, 'index.js.bak'))).toBe(false);
  });

  test('exits non-zero when a patch cannot be un-applied', () => {
    setupSequence();
    overwriteFile(join(TEST_DIR, 'node_modules', PKG, 'index.js'), 'something else entirely\n');

    const result = run(`rebase ${PKG} 0`, TEST_DIR);

    // Напечатать ❌ и выйти с нулём значит соврать вызывающему, включая CI.
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toContain('Stopped after 0 of 2');
  });

  test('inverting a patch twice gives the same patch back', () => {
    const parsed = parsePatch(`diff --git a/node_modules/${PKG}/renamed.js b/node_modules/${PKG}/moved.js
old mode 100644
new mode 100755
rename from node_modules/${PKG}/renamed.js
rename to node_modules/${PKG}/moved.js
--- a/node_modules/${PKG}/renamed.js
+++ b/node_modules/${PKG}/moved.js
@@ -1,2 +1,2 @@
-before
+after
 kept
\\ No newline at end of file
`);

    expect(parsed).toHaveLength(1);
    expect(parsed.map(invertTarget).map(invertTarget)).toEqual(parsed);
    // А один раз — переворачивает: стороны, режимы и направление переименования.
    const once = invertTarget(parsed[0]);
    expect(once.oldPath).toBe(parsed[0].newPath);
    expect(once.newMode).toBe(parsed[0].oldMode);
    expect(once.renameTo).toBe(parsed[0].renameFrom);
    expect(once.hunks[0].lines).toEqual(['+before', '-after', ' kept']);
  });
});

// Патчи последовательности строятся друг на друге, поэтому порядок обязан быть
// одним и тем же при любом ответе readdirSync — ради этого функция и заведена.
describe('the order patches are applied in', () => {
  test('goes by sequence number', () => {
    expect(orderPatchFiles(['pkg+1.0.0+010+j.patch', 'pkg+1.0.0+002+b.patch', 'pkg+1.0.0+001+a.patch']))
      .toEqual(['pkg+1.0.0+001+a.patch', 'pkg+1.0.0+002+b.patch', 'pkg+1.0.0+010+j.patch']);
  });

  test('does not depend on the order the files come in, even at the same number', () => {
    // Два патча с одним номером — вещь рукотворная, но имена и правят руками.
    // Компаратор возвращал для них ноль, сортировка стабильна, и порядок
    // оставался тем, в каком файлы отдал readdirSync: на одной машине один, на
    // другой другой, а патчи ложатся друг на друга.
    const files = ['pkg+1.0.0+001+bbb.patch', 'pkg+1.0.0+001+aaa.patch'];

    expect(orderPatchFiles(files)).toEqual(orderPatchFiles([...files].reverse()));
    expect(orderPatchFiles(files)).toEqual(['pkg+1.0.0+001+aaa.patch', 'pkg+1.0.0+001+bbb.patch']);
  });

  test('keeps patches of different packages apart by name', () => {
    expect(orderPatchFiles(['zebra+1.0.0.patch', 'alpha+2.0.0+001+x.patch']))
      .toEqual(['alpha+2.0.0+001+x.patch', 'zebra+1.0.0.patch']);
  });
});

// Патч может лечь не туда, где написано: файл в реестре успел сдвинуться. Один
// раз узнать его после этого надо уметь — иначе apply в postinstall кладёт его
// заново на каждый `bun install`.
describe('a patch that landed with an offset', () => {
  const PATCH = `--- a/node_modules/test-lib/index.js
+++ b/node_modules/test-lib/index.js
@@ -1,3 +1,4 @@
 line one
 line two
 line three
+APPENDED
`;

  function setup(prefix: string) {
    setupFakePackage(TEST_DIR, 'test-lib', '1.0.0', {
      'index.js': `${prefix}line one\nline two\nline three\n`,
    });
    mkdirSync(join(TEST_DIR, 'patches'), {recursive: true});
    writeFileSync(join(TEST_DIR, 'patches', 'test-lib+1.0.0.patch'), PATCH);
  }

  const content = () => readFileSync(join(TEST_DIR, 'node_modules', 'test-lib', 'index.js'), 'utf-8');

  test('is applied once and recognised afterwards', () => {
    // Две лишние строки сверху: хунк объявлен на первой строке, а сядет на третьей.
    setup('extra one\nextra two\n');

    expect(run('apply', TEST_DIR).stdout).toContain('1 applied, 0 failed');
    const afterFirst = content();
    expect(afterFirst).toContain('APPENDED');

    const again = run('apply', TEST_DIR);

    expect(again.stdout).toContain('already applied');
    // Раньше здесь дописывалась вторая копия — и третья, и четвёртая.
    expect(content()).toBe(afterFirst);
    expect(content().split('APPENDED')).toHaveLength(2);
  });

  test('status sees it in the tree', () => {
    setup('extra one\nextra two\n');
    run('apply', TEST_DIR);

    const result = run('status', TEST_DIR);

    expect(result.stdout).toContain('✅ test-lib+1.0.0.patch — in the tree');
    expect(result.exitCode).toBe(0);
  });

  test('and rebase can take it back off', () => {
    setup('extra one\nextra two\n');
    const before = content();
    run('apply', TEST_DIR);

    expect(run('rebase test-lib 0', TEST_DIR).exitCode).toBe(0);

    expect(content()).toBe(before);
  });
});

// Несколько хунков в одном файле — случая не было в сюите вовсе: все
// многохунковые патчи здесь были про разные файлы. А между хунками одного файла
// живёт накопленный сдвиг: первый меняет длину, и второй обязан сесть с
// поправкой на неё. Заодно это единственное место, где применение правит массив
// строк не с чистого листа, — а массив этот принадлежит вызывающему, потому что
// проверка «уже применён» зовёт применение дважды на одних и тех же строках.
describe('several hunks in one file', () => {
  const source = Array.from({length: 30}, (_, i) => `line ${i + 1}`).join('\n') + '\n';
  const file = () => join(TEST_DIR, 'node_modules', 'test-lib', 'index.js');
  const content = () => readFileSync(file(), 'utf-8');

  function setup(patch: string) {
    setupFakePackage(TEST_DIR, 'test-lib', '1.0.0', {'index.js': source});
    mkdirSync(join(TEST_DIR, 'patches'), {recursive: true});
    writeFileSync(join(TEST_DIR, 'patches', 'test-lib+1.0.0.patch'), patch);
  }

  const header = `--- a/node_modules/test-lib/index.js
+++ b/node_modules/test-lib/index.js
`;

  test('the second hunk lands shifted by what the first one added', () => {
    // Первый хунк удлиняет файл на две строки, второй объявлен по номерам
    // исходного файла — сесть он обязан на две строки ниже.
    setup(header + `@@ -1,3 +1,5 @@
 line 1
+added one
+added two
 line 2
 line 3
@@ -19,3 +21,3 @@
 line 19
-line 20
+line twenty
 line 21
`);

    expect(run('apply', TEST_DIR).stdout).toContain('1 applied, 0 failed');

    const expected = ['line 1', 'added one', 'added two',
      ...Array.from({length: 18}, (_, i) => `line ${i + 2}`),
      'line twenty',
      ...Array.from({length: 10}, (_, i) => `line ${i + 21}`)].join('\n') + '\n';
    expect(content()).toBe(expected);

    // Второй прогон обязан узнать патч и не тронуть файл.
    const again = run('apply', TEST_DIR);
    expect(again.stdout).toContain('already applied');
    expect(content()).toBe(expected);

    // И круг замыкается: откат возвращает файл побайтово.
    expect(run('rebase test-lib 0', TEST_DIR).exitCode).toBe(0);
    expect(content()).toBe(source);
  });

  test('the second hunk lands shifted by what the first one removed', () => {
    setup(header + `@@ -1,4 +1,2 @@
 line 1
-line 2
-line 3
 line 4
@@ -19,3 +17,3 @@
 line 19
-line 20
+line twenty
 line 21
`);

    expect(run('apply', TEST_DIR).stdout).toContain('1 applied, 0 failed');

    const expected = ['line 1', 'line 4',
      ...Array.from({length: 15}, (_, i) => `line ${i + 5}`),
      'line twenty',
      ...Array.from({length: 10}, (_, i) => `line ${i + 21}`)].join('\n') + '\n';
    expect(content()).toBe(expected);

    expect(run('apply', TEST_DIR).stdout).toContain('already applied');
    expect(content()).toBe(expected);
    expect(run('rebase test-lib 0', TEST_DIR).exitCode).toBe(0);
    expect(content()).toBe(source);
  });

  test('the shift decides which of two identical blocks the hunk lands on', () => {
    // Тот же кусок кода встречается в файле дважды, и второй хунк объявлен про
    // второй из них. Первый хунк удлинил файл, поэтому искать второй надо со
    // сдвигом: без него ближайшим к объявленному месту оказывается ЧУЖОЙ блок,
    // и патч молча правит не ту копию. Проверено мутацией: снимаешь `+ offset`
    // — правится первый блок, а вся остальная сюита остаётся зелёной.
    const before = ['head', 'filler', 'marker', 'target', 'end', 'spacer', 'marker', 'target', 'end'];
    setupFakePackage(TEST_DIR, 'test-lib', '1.0.0', {'index.js': before.join('\n') + '\n'});
    mkdirSync(join(TEST_DIR, 'patches'), {recursive: true});
    writeFileSync(join(TEST_DIR, 'patches', 'test-lib+1.0.0.patch'), header + `@@ -1,1 +1,4 @@
 head
+added one
+added two
+added three
@@ -7,3 +10,3 @@
 marker
-target
+patched
 end
`);

    expect(run('apply', TEST_DIR).stdout).toContain('1 applied, 0 failed');

    expect(content()).toBe(['head', 'added one', 'added two', 'added three',
      'filler', 'marker', 'target', 'end', 'spacer', 'marker', 'patched', 'end'].join('\n') + '\n');

    expect(run('apply', TEST_DIR).stdout).toContain('already applied');
    expect(run('rebase test-lib 0', TEST_DIR).exitCode).toBe(0);
    expect(content()).toBe(before.join('\n') + '\n');
  });

  test('a patch that is half in the tree is refused, not finished', () => {
    // Первый хунк в дереве уже есть, второго нет. Проверка «уже применён»
    // разбирает файл обратной стороной, и первый хунк ей сходится: если бы она
    // писала в тот же массив строк, что и прямое применение, прямое считалось бы
    // по наполовину откаченному файлу — и патч ложился бы с рапортом ✅ вместо
    // отказа. Измерено: снимаешь копию массива — здесь `1 applied, 0 failed` и
    // изменённый файл.
    const half = Array.from({length: 30}, (_, i) => `line ${i + 1}`);
    half[4] = 'line five';
    setupFakePackage(TEST_DIR, 'test-lib', '1.0.0', {'index.js': half.join('\n') + '\n'});
    mkdirSync(join(TEST_DIR, 'patches'), {recursive: true});
    writeFileSync(join(TEST_DIR, 'patches', 'test-lib+1.0.0.patch'), header + `@@ -4,3 +4,3 @@
 line 4
-line 5
+line five
 line 6
@@ -19,3 +19,3 @@
 line 19
-line 20
+line twenty
 line 21
`);

    const before = content();
    const result = run('apply', TEST_DIR);

    expect(result.stdout).toContain('0 applied, 1 failed');
    expect(result.exitCode).not.toBe(0);
    expect(content()).toBe(before);
  });

  test('a hunk larger than the splice limit lands whole', () => {
    // Строки вставляются в массив разом, а предел числа аргументов вызова у
    // рантайма конечен: на bun 1.0.36 splice падает RangeError на 65 535
    // аргументах. Хунк крупнее порога идёт другим путём, и путь этот обязан
    // давать тот же файл.
    const inserted = Array.from({length: 9000}, (_, i) => `inserted ${i + 1}`);
    setupFakePackage(TEST_DIR, 'test-lib', '1.0.0', {'index.js': 'head\ntail\n'});
    mkdirSync(join(TEST_DIR, 'patches'), {recursive: true});
    writeFileSync(join(TEST_DIR, 'patches', 'test-lib+1.0.0.patch'),
      header + `@@ -1,2 +1,9002 @@\n head\n${inserted.map(line => `+${line}`).join('\n')}\n tail\n`);

    expect(run('apply', TEST_DIR).stdout).toContain('1 applied, 0 failed');

    const expected = ['head', ...inserted, 'tail'].join('\n') + '\n';
    expect(content()).toBe(expected);

    expect(run('apply', TEST_DIR).stdout).toContain('already applied');
    expect(content()).toBe(expected);
  });
});

// Пакет обновили, патч остался от старой версии. `apply` о таком только
// предупреждает; retarget переписывает патчи под установленную версию.
//
// ms@2.1.2 → 2.1.3 меняет ровно одну строку: `function(val` на `function (val`.
// На ней и строятся оба интересных случая — «больше не ложится» и «уже внутри».
describe('retarget', () => {
  const OLD_LINE = 'module.exports = function(val, options) {';
  const NEW_LINE = 'module.exports = function (val, options) {';
  const file = () => join(TEST_DIR, 'node_modules', 'ms', 'index.js');

  function installAndPatch(edit: (source: string) => string, append?: string) {
    execSync('bun add ms@2.1.2', {cwd: TEST_DIR, stdio: 'pipe'});
    overwriteFile(file(), edit(readFileSync(file(), 'utf-8')));
    return run(append === undefined ? 'create ms' : `create ms --append ${append}`, TEST_DIR);
  }

  function upgrade() {
    execSync('bun add ms@2.1.3', {cwd: TEST_DIR, stdio: 'pipe'});
    expect(readFileSync(file(), 'utf-8')).toContain(NEW_LINE);
  }

  test('moves a patch to the installed version', () => {
    installAndPatch(source => `// MY FIX\n${source}`);
    expect(existsSync(join(TEST_DIR, 'patches', 'ms+2.1.2.patch'))).toBe(true);
    upgrade();

    const result = run('retarget ms', TEST_DIR);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('ms+2.1.2.patch → ms+2.1.3.patch');
    expect(existsSync(join(TEST_DIR, 'patches', 'ms+2.1.2.patch'))).toBe(false);

    // Патч теперь точен для новой версии: строки контекста взяты из неё.
    const moved = readFileSync(join(TEST_DIR, 'patches', 'ms+2.1.3.patch'), 'utf-8');
    expect(moved).toContain('+// MY FIX');

    expect(run('apply', TEST_DIR).stdout).toContain('1 applied, 0 failed');
    expect(readFileSync(file(), 'utf-8')).toContain('// MY FIX');
  });

  test('refuses when the patch no longer fits, and leaves everything alone', () => {
    // Патч трогает ту самую строку, которая в 2.1.3 изменилась.
    installAndPatch(source => source.replace(OLD_LINE, `${OLD_LINE}\n  // CHECKED`));
    upgrade();

    const result = run('retarget ms', TEST_DIR);

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toContain('does not fit ms@2.1.3');
    // Подгонять контекст мы не будем, но и старый патч не тронем.
    expect(existsSync(join(TEST_DIR, 'patches', 'ms+2.1.2.patch'))).toBe(true);
    expect(existsSync(join(TEST_DIR, 'patches', 'ms+2.1.3.patch'))).toBe(false);
  });

  test('drops a patch whose change is already in the new version', () => {
    // Ровно то, что сделали выше по течению между 2.1.2 и 2.1.3.
    installAndPatch(source => source.replace(OLD_LINE, NEW_LINE));
    upgrade();

    const result = run('retarget ms', TEST_DIR);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('already in 2.1.3, dropping it');
    expect(result.stdout).toContain('all changes are already there');
    expect(readdirSync(join(TEST_DIR, 'patches'))).toEqual([]);
  });

  test('moves a whole sequence, keeping numbers and labels', () => {
    installAndPatch(source => `// FIRST\n${source}`);
    overwriteFile(file(), readFileSync(file(), 'utf-8') + '\n// SECOND\n');
    run('create ms --append second', TEST_DIR);
    expect(readdirSync(join(TEST_DIR, 'patches')).sort()).toEqual([
      'ms+2.1.2+001+initial.patch',
      'ms+2.1.2+002+second.patch',
    ]);
    upgrade();

    const result = run('retarget ms', TEST_DIR);

    expect(result.exitCode).toBe(0);
    expect(readdirSync(join(TEST_DIR, 'patches')).sort()).toEqual([
      'ms+2.1.3+001+initial.patch',
      'ms+2.1.3+002+second.patch',
    ]);
    // Каждый патч по-прежнему несёт только своё.
    const first = readFileSync(join(TEST_DIR, 'patches', 'ms+2.1.3+001+initial.patch'), 'utf-8');
    const second = readFileSync(join(TEST_DIR, 'patches', 'ms+2.1.3+002+second.patch'), 'utf-8');
    expect(first).toContain('+// FIRST');
    expect(first).not.toContain('SECOND');
    expect(second).toContain('+// SECOND');
    expect(second).not.toContain('FIRST');

    expect(run('apply', TEST_DIR).stdout).toContain('2 applied, 0 failed');
  });

  // Патч с `rename from/to` приезжает от git и patch-package. Пока
  // переименование не воспроизводилось на эталоне, retarget видел между
  // снимками пустоту и **удалял** такой патч со словами «его правка уже в новой
  // версии» — переименования не оставалось нигде.
  test('carries a rename over to the new version instead of dropping the patch', () => {
    execSync('bun add ms@2.1.2', {cwd: TEST_DIR, stdio: 'pipe'});
    mkdirSync(join(TEST_DIR, 'patches'), {recursive: true});
    writeFileSync(
      join(TEST_DIR, 'patches', 'ms+2.1.2.patch'),
      `diff --git a/node_modules/ms/index.js b/node_modules/ms/renamed.js
similarity index 100%
rename from node_modules/ms/index.js
rename to node_modules/ms/renamed.js
`,
    );
    expect(run('apply', TEST_DIR).exitCode).toBe(0);
    upgrade();

    const result = run('retarget ms', TEST_DIR);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain('dropping it');
    expect(existsSync(join(TEST_DIR, 'patches', 'ms+2.1.3.patch'))).toBe(true);

    // Переносится оно как удаление и добавление: наш create строится на `diff
    // -r`, заголовков rename он не выпускает — но результат тот же.
    expect(run('apply', TEST_DIR).exitCode).toBe(0);
    expect(existsSync(join(TEST_DIR, 'node_modules', 'ms', 'renamed.js'))).toBe(true);
    expect(existsSync(join(TEST_DIR, 'node_modules', 'ms', 'index.js'))).toBe(false);
  });

  test('says there is nothing to do when the versions already match', () => {
    setupFakePackage(TEST_DIR, 'test-lib', '1.0.0', {'index.js': 'const a = 1;\n'});
    mkdirSync(join(TEST_DIR, 'patches'), {recursive: true});
    writeFileSync(join(TEST_DIR, 'patches', 'test-lib+1.0.0.patch'), `--- a/node_modules/test-lib/index.js
+++ b/node_modules/test-lib/index.js
@@ -1 +1 @@
-const a = 1;
+const a = 2;
`);

    const result = run('retarget test-lib', TEST_DIR);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('already target 1.0.0');
    // И до сети дело не дошло.
    expect(result.stdout).not.toContain('Fetching pristine');
  });

  test('refuses when the patches carry more than one version', () => {
    setupFakePackage(TEST_DIR, 'test-lib', '2.0.0', {'index.js': 'const a = 1;\n'});
    mkdirSync(join(TEST_DIR, 'patches'), {recursive: true});
    writeFileSync(join(TEST_DIR, 'patches', 'test-lib+1.0.0+001+one.patch'), 'x');
    writeFileSync(join(TEST_DIR, 'patches', 'test-lib+1.5.0+002+two.patch'), 'x');

    const result = run('retarget test-lib', TEST_DIR);

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toContain('more than one version');
    expect(result.stdout).not.toContain('Fetching pristine');
  });
});

// `engines` обещает bun >= 1.0.0. Обещание проверяется в CI отдельным заданием
// на 1.0, 1.1 и 1.2 — сюиту там не запустить. Здесь закреплён сам договор,
// из-за нарушения которого `apply` на bun 1.1 падал с EEXIST.
describe('ensureDir', () => {
  test('does not mind a directory that is already there', () => {
    const nested = join(TEST_DIR, 'one', 'two', 'three');

    ensureDir(nested);
    expect(existsSync(nested)).toBe(true);

    // Второй раз — то же самое и без единого звука.
    expect(() => ensureDir(nested)).not.toThrow();
    expect(() => ensureDir(join(TEST_DIR, 'one'))).not.toThrow();
  });

  test('still complains when the path is a file', () => {
    const file = join(TEST_DIR, 'not-a-dir');
    writeFileSync(file, 'x');

    // EEXIST мы глотаем, ENOTDIR и прочее — нет: это уже не «уже есть».
    expect(() => ensureDir(join(file, 'child'))).toThrow();
  });
});

describe('edit before you patch', () => {
  // Как bun раскладывает пакеты при --backend=hardlink, то есть по умолчанию на
  // Linux: файл в node_modules и запись в кеше — один инод.
  function shareWithCache(file: string, cacheEntry: string) {
    linkSync(file, cacheEntry);
    expect(statSync(cacheEntry).ino).toBe(statSync(file).ino);
  }

  test('editing in place reaches the cache entry when nothing detached it', () => {
    // Предпосылка всей команды. Перестанет быть правдой — узнать об этом лучше
    // отсюда, а не из молчаливо бесполезной команды.
    setupFakePackage(TEST_DIR, 'test-lib', '1.0.0', {'index.js': 'const a = 1;\n'});
    const file = join(TEST_DIR, 'node_modules', 'test-lib', 'index.js');
    const cacheEntry = join(TEST_DIR, 'cache-entry.js');
    shareWithCache(file, cacheEntry);

    writeFileSync(file, 'const a = 2;\n'); // так пишет редактор: в тот же инод

    expect(readFileSync(cacheEntry, 'utf-8')).toBe('const a = 2;\n');
  });

  test('detaches the package so editing it no longer changes the cache', () => {
    setupFakePackage(TEST_DIR, 'test-lib', '1.0.0', {'index.js': 'const a = 1;\n'});
    const file = join(TEST_DIR, 'node_modules', 'test-lib', 'index.js');
    const cacheEntry = join(TEST_DIR, 'cache-entry.js');
    shareWithCache(file, cacheEntry);

    const result = run('edit test-lib', TEST_DIR);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Detached');

    expect(statSync(file).ino).not.toBe(statSync(cacheEntry).ino);
    expect(readFileSync(file, 'utf-8')).toBe('const a = 1;\n');

    writeFileSync(file, 'const a = 2;\n');
    expect(readFileSync(cacheEntry, 'utf-8')).toBe('const a = 1;\n');
  });

  test('detaches nested files too', () => {
    setupFakePackage(TEST_DIR, 'test-lib', '1.0.0', {'lib/deep/inner.js': 'deep\n'});
    const file = join(TEST_DIR, 'node_modules', 'test-lib', 'lib', 'deep', 'inner.js');
    const cacheEntry = join(TEST_DIR, 'cache-inner.js');
    shareWithCache(file, cacheEntry);

    expect(run('edit test-lib', TEST_DIR).exitCode).toBe(0);

    writeFileSync(file, 'changed\n');
    expect(readFileSync(cacheEntry, 'utf-8')).toBe('deep\n');
  });

  test('carries binary content through byte for byte', () => {
    setupFakePackage(TEST_DIR, 'test-lib', '1.0.0', {'index.js': 'const a = 1;\n'});
    const blob = join(TEST_DIR, 'node_modules', 'test-lib', 'native.node');
    const bytes = Buffer.from([0x00, 0x01, 0xff, 0xfe, 0x00, 0x80, 0x0a]);
    writeFileSync(blob, bytes);
    shareWithCache(blob, join(TEST_DIR, 'cache-native.node'));

    expect(run('edit test-lib', TEST_DIR).exitCode).toBe(0);

    expect(readFileSync(blob).equals(bytes)).toBe(true);
  });

  test.skipIf(isWindows)('keeps the executable bit', () => {
    setupFakePackage(TEST_DIR, 'test-lib', '1.0.0', {'bin/run.sh': '#!/bin/sh\necho hi\n'});
    const script = join(TEST_DIR, 'node_modules', 'test-lib', 'bin', 'run.sh');
    chmodSync(script, 0o755);
    shareWithCache(script, join(TEST_DIR, 'cache-run.sh'));

    expect(run('edit test-lib', TEST_DIR).exitCode).toBe(0);

    expect(isExecutable(script)).toBe(true);
  });

  test.skipIf(isWindows)('leaves symbolic links as links', () => {
    setupFakePackage(TEST_DIR, 'test-lib', '1.0.0', {'index.js': 'const a = 1;\n'});
    const pkg = join(TEST_DIR, 'node_modules', 'test-lib');

    // Ссылка ведёт наружу пакета, на файл, который сам делит инод с кешем и
    // мимо обхода проходит. Так «пошли по ссылке» отличимо от «пропустили»:
    // цель остаётся разделённой, и пройди мы по ссылке — на месте alias.js
    // оказался бы обычный файл.
    const shared = join(TEST_DIR, 'shared.js');
    writeFileSync(shared, 'shared\n');
    shareWithCache(shared, join(TEST_DIR, 'cache-shared.js'));
    symlinkSync('../../shared.js', join(pkg, 'alias.js'));

    shareWithCache(join(pkg, 'index.js'), join(TEST_DIR, 'cache-index.js'));

    expect(run('edit test-lib', TEST_DIR).exitCode).toBe(0);

    expect(lstatSync(join(pkg, 'alias.js')).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(pkg, 'alias.js'), 'utf-8')).toBe('shared\n');
  });

  test('leaves files that are nobody else’s alone', () => {
    setupFakePackage(TEST_DIR, 'test-lib', '1.0.0', {'index.js': 'const a = 1;\n'});
    const file = join(TEST_DIR, 'node_modules', 'test-lib', 'index.js');
    const inodeBefore = statSync(file).ino;

    const result = run('edit test-lib', TEST_DIR);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Nothing to detach');
    expect(statSync(file).ino).toBe(inodeBefore);
  });

  test('refuses a package bun patches itself', () => {
    setupFakePackage(TEST_DIR, 'test-lib', '1.0.0', {'index.js': 'const a = 1;\n'});
    writeFileSync(
      join(TEST_DIR, 'package.json'),
      JSON.stringify({
        name: 'test-project',
        version: '1.0.0',
        patchedDependencies: {'test-lib@1.0.0': 'patches/test-lib@1.0.0.patch'},
      }),
    );

    const result = run('edit test-lib', TEST_DIR);
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toContain('already patched by bun');
  });

  test.skipIf(isWindows)('refuses to detach through a link that leaves the project', () => {
    // Изолированная раскладка ведёт node_modules/<pkg> симлинком в стор, и у
    // bun бывает вариант, где этот стор лежит в общем кеше. Разрывать хардлинки
    // там нельзя: писали бы прямо в то, от чего команда защищает.
    const store = `${TEST_DIR}-store`;
    rmSync(store, {force: true, recursive: true});
    mkdirSync(join(store, 'test-lib'), {recursive: true});
    writeFileSync(join(store, 'test-lib', 'package.json'), JSON.stringify({name: 'test-lib', version: '1.0.0'}));
    writeFileSync(join(store, 'test-lib', 'index.js'), 'const a = 1;\n');
    mkdirSync(join(TEST_DIR, 'node_modules'), {recursive: true});
    symlinkSync(join(store, 'test-lib'), join(TEST_DIR, 'node_modules', 'test-lib'));

    try {
      const result = run('edit test-lib', TEST_DIR);
      expect(result.exitCode).not.toBe(0);
      expect(result.stdout).toContain('outside the project');
      expect(readFileSync(join(store, 'test-lib', 'index.js'), 'utf-8')).toBe('const a = 1;\n');
    } finally {
      rmSync(store, {force: true, recursive: true});
    }
  });

  test('says which package is missing, and asks for one when none is given', () => {
    mkdirSync(join(TEST_DIR, 'node_modules'), {recursive: true});

    const missing = run('edit no-such-package', TEST_DIR);
    expect(missing.exitCode).not.toBe(0);
    expect(missing.stdout).toContain('not found in node_modules');

    const nameless = run('edit', TEST_DIR);
    expect(nameless.exitCode).not.toBe(0);
    expect(nameless.stdout).toContain('Usage');
  });
});

describe('why a patch exists', () => {
  function fakePatch(body: string, header = '') {
    setupFakePackage(TEST_DIR, 'test-lib', '1.0.0', {'index.js': 'const a = 1;\n'});
    mkdirSync(join(TEST_DIR, 'patches'), {recursive: true});
    writeFileSync(join(TEST_DIR, 'patches', 'test-lib+1.0.0.patch'), header + body);
  }

  const BODY = `--- a/node_modules/test-lib/index.js
+++ b/node_modules/test-lib/index.js
@@ -1 +1 @@
-const a = 1;
+const a = 2;
`;

  test('create writes the header, and the body is what it would have been', () => {
    execSync('bun add is-number@7.0.0', {cwd: TEST_DIR, stdio: 'pipe'});
    const indexPath = join(TEST_DIR, 'node_modules', 'is-number', 'index.js');
    overwriteFile(indexPath, readFileSync(indexPath, 'utf-8') + '\n// fixed\n');

    expect(run('create is-number --why "breaks SSR" --upstream https://example.com/issues/7', TEST_DIR).exitCode).toBe(0);

    const written = readFileSync(join(TEST_DIR, 'patches', 'is-number+7.0.0.patch'), 'utf-8');
    expect(written.startsWith('Why: breaks SSR\nUpstream: https://example.com/issues/7\n\ndiff --git ')).toBe(true);

    // Тело — ровно то же, что без заголовка: заголовок ничего не сдвигает.
    rmSync(join(TEST_DIR, 'patches'), {force: true, recursive: true});
    run('create is-number', TEST_DIR);
    const plain = readFileSync(join(TEST_DIR, 'patches', 'is-number+7.0.0.patch'), 'utf-8');
    expect(written.slice(written.indexOf('diff --git '))).toBe(plain);
  });

  test('the header survives create rewriting the patch', () => {
    execSync('bun add is-number@7.0.0', {cwd: TEST_DIR, stdio: 'pipe'});
    const indexPath = join(TEST_DIR, 'node_modules', 'is-number', 'index.js');
    const original = readFileSync(indexPath, 'utf-8');
    overwriteFile(indexPath, original + '\n// one\n');
    run('create is-number --why "it breaks" --upstream https://example.com/1', TEST_DIR);

    overwriteFile(indexPath, original + '\n// one\n// two\n');
    expect(run('create is-number', TEST_DIR).exitCode).toBe(0);

    const patch = readFileSync(join(TEST_DIR, 'patches', 'is-number+7.0.0.patch'), 'utf-8');
    expect(patch).toContain('Why: it breaks');
    expect(patch).toContain('Upstream: https://example.com/1');
    expect(patch).toContain('+// two');
  });

  test('--why replaces the old reason and keeps lines written by hand', () => {
    execSync('bun add is-number@7.0.0', {cwd: TEST_DIR, stdio: 'pipe'});
    const indexPath = join(TEST_DIR, 'node_modules', 'is-number', 'index.js');
    const original = readFileSync(indexPath, 'utf-8');
    overwriteFile(indexPath, original + '\n// one\n');
    run('create is-number --why "first guess"', TEST_DIR);

    const patchPath = join(TEST_DIR, 'patches', 'is-number+7.0.0.patch');
    const handwritten = readFileSync(patchPath, 'utf-8').replace('Why: first guess\n', 'Why: first guess\n# see also the thread in chat\n');
    writeFileSync(patchPath, handwritten);

    overwriteFile(indexPath, original + '\n// two\n');
    run('create is-number --why "the real reason"', TEST_DIR);

    const patch = readFileSync(patchPath, 'utf-8');
    expect(patch).toContain('Why: the real reason');
    expect(patch).not.toContain('first guess');
    expect(patch).toContain('# see also the thread in chat');
  });

  test('apply reads a patch with a header exactly like one without', () => {
    fakePatch(BODY, 'Why: because\nUpstream: https://example.com/2\n\n');
    expect(run('apply', TEST_DIR).exitCode).toBe(0);
    expect(readFileSync(join(TEST_DIR, 'node_modules', 'test-lib', 'index.js'), 'utf-8')).toBe('const a = 2;\n');

    // И повторный apply по-прежнему ничего не делает.
    expect(run('apply', TEST_DIR).stdout).toContain('already applied');
  });

  test('apply reads a git-style header too', () => {
    fakePatch(BODY, 'From: someone\nSubject: [PATCH] make a work\n\n');
    expect(run('apply', TEST_DIR).exitCode).toBe(0);
    expect(readFileSync(join(TEST_DIR, 'node_modules', 'test-lib', 'index.js'), 'utf-8')).toBe('const a = 2;\n');
  });

  test('status shows the reason, and separates a header edit from a real one', () => {
    fakePatch(BODY, 'Why: because\n\n');
    run('apply', TEST_DIR);

    const shown = run('status', TEST_DIR);
    expect(shown.stdout).toContain('in the tree');
    expect(shown.stdout).toContain('because');

    const patchPath = join(TEST_DIR, 'patches', 'test-lib+1.0.0.patch');
    writeFileSync(patchPath, 'Why: a better explanation\n\n' + BODY);
    const afterHeaderEdit = run('status', TEST_DIR);
    expect(afterHeaderEdit.stdout).toContain('only its header changed');
    expect(afterHeaderEdit.stdout).toContain('a better explanation');

    writeFileSync(patchPath, 'Why: a better explanation\n\n' + BODY.replace('+const a = 2;', '+const a = 3;'));
    expect(run('status', TEST_DIR).stdout).toContain('the patch file changed');
  });

  test('retarget carries the header to the new version', () => {
    execSync('bun add ms@2.1.2', {cwd: TEST_DIR, stdio: 'pipe'});
    const file = join(TEST_DIR, 'node_modules', 'ms', 'index.js');
    overwriteFile(file, `// MY FIX\n${readFileSync(file, 'utf-8')}`);
    run('create ms --why "upstream lost the fix" --upstream https://example.com/ms/1', TEST_DIR);

    execSync('bun add ms@2.1.3', {cwd: TEST_DIR, stdio: 'pipe'});
    expect(run('retarget ms', TEST_DIR).exitCode).toBe(0);

    const moved = readFileSync(join(TEST_DIR, 'patches', 'ms+2.1.3.patch'), 'utf-8');
    expect(moved.startsWith('Why: upstream lost the fix\nUpstream: https://example.com/ms/1\n\n')).toBe(true);
    expect(moved).toContain('+// MY FIX');
  });

  test('a patch appended to a sequence starts without a reason of its own', () => {
    execSync('bun add is-number@7.0.0', {cwd: TEST_DIR, stdio: 'pipe'});
    const indexPath = join(TEST_DIR, 'node_modules', 'is-number', 'index.js');
    const original = readFileSync(indexPath, 'utf-8');
    overwriteFile(indexPath, original + '\n// one\n');
    run('create is-number --why "the first one"', TEST_DIR);
    run('apply', TEST_DIR);

    overwriteFile(indexPath, readFileSync(indexPath, 'utf-8') + '// two\n');
    expect(run('create is-number --append second', TEST_DIR).exitCode).toBe(0);

    const appended = readFileSync(join(TEST_DIR, 'patches', 'is-number+7.0.0+002+second.patch'), 'utf-8');
    expect(appended.startsWith('diff --git ')).toBe(true);
    expect(appended).not.toContain('the first one');
  });

  test('refuses a reason that would be read as a diff', () => {
    execSync('bun add is-number@7.0.0', {cwd: TEST_DIR, stdio: 'pipe'});
    const indexPath = join(TEST_DIR, 'node_modules', 'is-number', 'index.js');
    overwriteFile(indexPath, readFileSync(indexPath, 'utf-8') + '\n// fixed\n');

    const structural = run('create is-number --why "--- a/x"', TEST_DIR);
    expect(structural.exitCode).not.toBe(0);
    expect(structural.stdout).toContain('must not start like a line of a diff');

    // Многострочную причину через CLI не передать переносимо: подстановка
    // `$(printf …)` — это POSIX-шелл, а на Windows тест запускается в cmd и
    // строка приезжает литералом. Проверка та же, но без шелла в середине.
    expect(() => parseOptions(['--why', 'one\ntwo'])).toThrow('must be a single line');
    expect(() => parseOptions(['--why', 'one\rtwo'])).toThrow('must be a single line');

    const notAUrl = run('create is-number --upstream github.com/x/y', TEST_DIR);
    expect(notAUrl.exitCode).not.toBe(0);
    expect(notAUrl.stdout).toContain('needs an http(s) URL');

    expect(existsSync(join(TEST_DIR, 'patches'))).toBe(false);
  });
});

describe('isolated layout and the shared store', () => {
  // Каталог вне проекта, куда ведёт симлинк, — то же, что общий стор bun при
  // `--linker isolated` с `BUN_INSTALL_GLOBAL_STORE=1`: измерено на 1.4.0, там
  // node_modules/<pkg> ведёт в <кеш>/links/… Ставить bun с таким стором внутри
  // сюиты незачем — важно, куда ведёт путь, а не кто его создал.
  const STORE = () => `${TEST_DIR}-store`;

  function packageInStore(patch: string) {
    const store = STORE();
    rmSync(store, {force: true, recursive: true});
    mkdirSync(join(store, 'test-lib'), {recursive: true});
    writeFileSync(join(store, 'test-lib', 'package.json'), JSON.stringify({name: 'test-lib', version: '1.0.0'}));
    writeFileSync(join(store, 'test-lib', 'index.js'), 'const a = 1;\n');

    mkdirSync(join(TEST_DIR, 'node_modules'), {recursive: true});
    symlinkSync(join(store, 'test-lib'), join(TEST_DIR, 'node_modules', 'test-lib'));

    mkdirSync(join(TEST_DIR, 'patches'), {recursive: true});
    writeFileSync(join(TEST_DIR, 'patches', 'test-lib+1.0.0.patch'), patch);
  }

  const PATCH = `--- a/node_modules/test-lib/index.js
+++ b/node_modules/test-lib/index.js
@@ -1 +1 @@
-const a = 1;
+const a = 2;
`;

  afterEach(() => {
    rmSync(STORE(), {force: true, recursive: true});
  });

  test.skipIf(isWindows)('apply refuses to write through a link that leaves the project', () => {
    packageInStore(PATCH);

    const result = run('apply', TEST_DIR);

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toContain("outside the project — that is bun's shared store");
    expect(result.stdout).toContain('BUN_INSTALL_GLOBAL_STORE=0');
    // Главное: в общем сторе ничего не изменилось.
    expect(readFileSync(join(STORE(), 'test-lib', 'index.js'), 'utf-8')).toBe('const a = 1;\n');
  });

  test.skipIf(isWindows)('reverse refuses too — un-applying writes to the tree just the same', () => {
    // Дерево уже содержит изменение патча: снятие было бы записью в общий стор.
    packageInStore(PATCH);
    writeFileSync(join(STORE(), 'test-lib', 'index.js'), 'const a = 2;\n');

    const result = run('reverse', TEST_DIR);

    expect(result.stdout).toContain("outside the project — that is bun's shared store");
    expect(readFileSync(join(STORE(), 'test-lib', 'index.js'), 'utf-8')).toBe('const a = 2;\n');
  });

  test.skipIf(isWindows)('status says so instead of answering about a tree that is not the project’s', () => {
    packageInStore(PATCH);

    const result = run('status', TEST_DIR);

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toContain("outside the project — that is bun's shared store");
  });

  test.skipIf(isWindows)('create warns that the package is shared', () => {
    packageInStore(PATCH);
    rmSync(join(TEST_DIR, 'patches'), {force: true, recursive: true});

    // Пакета нет в реестре, `create` дойдёт до скачивания эталона и там
    // остановится — предупреждение печатается раньше, и проверяется именно оно.
    const result = run('create test-lib', TEST_DIR);

    expect(result.stdout).toContain("is a link into bun's shared store");
  });

  test('apply refuses bun’s real global store, not just a link we made ourselves', () => {
    // Настоящая раскладка: bun 1.4 с `BUN_INSTALL_GLOBAL_STORE=1` и изолированным
    // линкером уводит node_modules/<pkg> в <кеш>/links/… Кеш кладём рядом с
    // проектом, а не внутрь: внутри он был бы частью проекта, и проверять было
    // бы нечего.
    const cache = `${TEST_DIR}-cache`;
    rmSync(cache, {force: true, recursive: true});
    const env = {...process.env, BUN_INSTALL_CACHE_DIR: cache, BUN_INSTALL_GLOBAL_STORE: '1'};

    try {
      execSync('bun add ms@2.1.2 --linker isolated', {cwd: TEST_DIR, stdio: 'pipe', env});

      const real = realpathSync(join(TEST_DIR, 'node_modules', 'ms'));
      expect(real.startsWith(cache)).toBe(true); // иначе проверять нечего

      mkdirSync(join(TEST_DIR, 'patches'), {recursive: true});
      writeFileSync(join(TEST_DIR, 'patches', 'ms+2.1.2.patch'), `--- a/node_modules/ms/index.js
+++ b/node_modules/ms/index.js
@@ -1,3 +1,4 @@
+// ЗАПЛАТА
 /**
  * Helpers.
  */
`);
      const before = readFileSync(join(real, 'index.js'), 'utf-8');

      const result = run('apply', TEST_DIR);

      expect(result.exitCode).not.toBe(0);
      expect(result.stdout).toContain("outside the project — that is bun's shared store");
      expect(readFileSync(join(real, 'index.js'), 'utf-8')).toBe(before);
    } finally {
      rmSync(cache, {force: true, recursive: true});
    }
  });

  test('the whole cycle works in an isolated layout', () => {
    execSync('bun add ms@2.1.2 --linker isolated', {cwd: TEST_DIR, stdio: 'pipe'});

    // Раскладка обязана быть изолированной, иначе тест зелен не по той причине.
    const link = join(TEST_DIR, 'node_modules', 'ms');
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readlinkSync(link).replace(/\\/g, '/')).toContain('.bun/');

    const indexPath = join(link, 'index.js');
    overwriteFile(indexPath, readFileSync(indexPath, 'utf-8') + '\n// ISOLATED FIX\n');

    expect(run('create ms', TEST_DIR).exitCode).toBe(0);
    execSync('bun install --linker isolated --force', {cwd: TEST_DIR, stdio: 'pipe'});
    expect(readFileSync(indexPath, 'utf-8')).not.toContain('// ISOLATED FIX');

    expect(run('apply', TEST_DIR).stdout).toContain('1 applied, 0 failed');
    expect(readFileSync(indexPath, 'utf-8')).toContain('// ISOLATED FIX');

    expect(run('apply', TEST_DIR).stdout).toContain('already applied');
    expect(run('status', TEST_DIR).stdout).toContain('1 of 1 in the tree');

    expect(run('reverse', TEST_DIR).stdout).toContain('1 of 1 un-applied');
    expect(readFileSync(indexPath, 'utf-8')).not.toContain('// ISOLATED FIX');
  });
});

describe('parseRepository', () => {
  // Три формы, которые должны давать правильный GitHub URL

  test('parses github: shorthand', () => {
    const result = parseRepository('github:acme/my-lib');
    expect(result).not.toBeNull();
    if (result === null || 'external' in result) throw new Error('expected github');
    expect(result.github).toBe('https://github.com/acme/my-lib');
    expect(result.owner).toBe('acme');
    expect(result.repoName).toBe('my-lib');
  });

  test('parses https GitHub URL with .git suffix', () => {
    const result = parseRepository('https://github.com/acme/my-lib.git');
    expect(result).not.toBeNull();
    if (result === null || 'external' in result) throw new Error('expected github');
    expect(result.github).toBe('https://github.com/acme/my-lib');
  });

  test('parses git+ssh GitHub URL', () => {
    const result = parseRepository('git+ssh://git@github.com/acme/my-lib.git');
    expect(result).not.toBeNull();
    if (result === null || 'external' in result) throw new Error('expected github');
    expect(result.github).toBe('https://github.com/acme/my-lib');
  });

  test('parses git+https GitHub URL', () => {
    const result = parseRepository('git+https://github.com/acme/my-lib.git');
    expect(result).not.toBeNull();
    if (result === null || 'external' in result) throw new Error('expected github');
    expect(result.github).toBe('https://github.com/acme/my-lib');
  });

  test('parses short org/repo form', () => {
    const result = parseRepository('acme/my-lib');
    expect(result).not.toBeNull();
    if (result === null || 'external' in result) throw new Error('expected github');
    expect(result.github).toBe('https://github.com/acme/my-lib');
  });

  test('parses repository object with url field', () => {
    const result = parseRepository({type: 'git', url: 'https://github.com/acme/my-lib.git'});
    expect(result).not.toBeNull();
    if (result === null || 'external' in result) throw new Error('expected github');
    expect(result.github).toBe('https://github.com/acme/my-lib');
  });

  test('returns external for non-GitHub URL, stripping git+ prefix and .git suffix', () => {
    // git+ и .git должны быть убраны — иначе URL неудобен для вставки в браузер.
    // Это же разграничивает эту ветку от запасной `return {external: raw}`.
    const result = parseRepository('git+https://gitlab.com/acme/my-lib.git');
    expect(result).not.toBeNull();
    if (result === null || !('external' in result)) throw new Error('expected external');
    expect(result.external).toContain('gitlab.com');
    expect(result.external).not.toContain('git+');
    expect(result.external).not.toContain('.git');
  });

  test('returns null for missing repository', () => {
    expect(parseRepository(null)).toBeNull();
    expect(parseRepository(undefined)).toBeNull();
    expect(parseRepository('')).toBeNull();
  });
});

describe('bunch-package upstream', () => {
  test('rejects path traversal with ../..', () => {
    // create уже проверяет имя — upstream обязан делать то же самое,
    // иначе join('node_modules', '../..') читает файлы снаружи проекта.
    const result = run('upstream ../..', TEST_DIR);
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toContain('Invalid package name');
    // Имя и версия чужого пакета не должны утекать в вывод
    expect(result.stdout).not.toContain('secret');
  });

  test('rejects path traversal with dot .', () => {
    const result = run('upstream .', TEST_DIR);
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toContain('Invalid package name');
  });

  test('fails clearly when package is not installed', () => {
    const result = run('upstream no-such-pkg', TEST_DIR);
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toContain('not installed');
  });

  test('fails when package has no repository field', () => {
    setupFakePackage(TEST_DIR, 'fakepkg', '1.0.0', {'index.js': 'x'});
    const result = run('upstream fakepkg', TEST_DIR);
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toContain('repository');
  });

  test('reports non-GitHub repository and exits cleanly', () => {
    mkdirSync(join(TEST_DIR, 'node_modules', 'gitlabpkg'), {recursive: true});
    writeFileSync(
      join(TEST_DIR, 'node_modules', 'gitlabpkg', 'package.json'),
      JSON.stringify({name: 'gitlabpkg', version: '1.0.0', repository: 'https://gitlab.com/acme/foo'}),
    );
    const result = run('upstream gitlabpkg', TEST_DIR);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('gitlab.com');
    expect(result.stdout).toContain('non-GitHub');
  });

  test('prints GitHub issue URL for github: shorthand repository', () => {
    mkdirSync(join(TEST_DIR, 'node_modules', 'hubpkg'), {recursive: true});
    writeFileSync(
      join(TEST_DIR, 'node_modules', 'hubpkg', 'package.json'),
      JSON.stringify({name: 'hubpkg', version: '2.0.0', repository: 'github:acme/hubpkg'}),
    );
    mkdirSync(join(TEST_DIR, 'patches'), {recursive: true});
    writeFileSync(
      join(TEST_DIR, 'patches', 'hubpkg+2.0.0.patch'),
      '--- a/node_modules/hubpkg/index.js\n+++ b/node_modules/hubpkg/index.js\n@@ -1 +1 @@\n-old\n+new\n',
    );
    const result = run('upstream hubpkg', TEST_DIR);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('https://github.com/acme/hubpkg/issues/new');
    expect(result.stdout).toContain('hubpkg%402.0.0');
  });

  test('prints GitHub issue URL for https repository URL', () => {
    mkdirSync(join(TEST_DIR, 'node_modules', 'urlpkg'), {recursive: true});
    writeFileSync(
      join(TEST_DIR, 'node_modules', 'urlpkg', 'package.json'),
      JSON.stringify({
        name: 'urlpkg',
        version: '3.0.0',
        repository: {type: 'git', url: 'https://github.com/acme/urlpkg.git'},
      }),
    );
    mkdirSync(join(TEST_DIR, 'patches'), {recursive: true});
    writeFileSync(
      join(TEST_DIR, 'patches', 'urlpkg+3.0.0.patch'),
      '--- a/node_modules/urlpkg/index.js\n+++ b/node_modules/urlpkg/index.js\n@@ -1 +1 @@\n-old\n+new\n',
    );
    const result = run('upstream urlpkg', TEST_DIR);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('https://github.com/acme/urlpkg/issues/new');
  });

  test('prints GitHub issue URL for short org/repo form', () => {
    mkdirSync(join(TEST_DIR, 'node_modules', 'shortpkg'), {recursive: true});
    writeFileSync(
      join(TEST_DIR, 'node_modules', 'shortpkg', 'package.json'),
      JSON.stringify({name: 'shortpkg', version: '1.0.0', repository: 'acme/shortpkg'}),
    );
    mkdirSync(join(TEST_DIR, 'patches'), {recursive: true});
    writeFileSync(
      join(TEST_DIR, 'patches', 'shortpkg+1.0.0.patch'),
      '--- a/node_modules/shortpkg/index.js\n+++ b/node_modules/shortpkg/index.js\n@@ -1 +1 @@\n-old\n+new\n',
    );
    const result = run('upstream shortpkg', TEST_DIR);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('https://github.com/acme/shortpkg/issues/new');
  });

  test('includes Why from patch header in issue URL', () => {
    mkdirSync(join(TEST_DIR, 'node_modules', 'whypkg'), {recursive: true});
    writeFileSync(
      join(TEST_DIR, 'node_modules', 'whypkg', 'package.json'),
      JSON.stringify({name: 'whypkg', version: '1.0.0', repository: 'github:acme/whypkg'}),
    );
    mkdirSync(join(TEST_DIR, 'patches'), {recursive: true});
    writeFileSync(
      join(TEST_DIR, 'patches', 'whypkg+1.0.0.patch'),
      'Why: fix a critical bug\n\n--- a/node_modules/whypkg/index.js\n+++ b/node_modules/whypkg/index.js\n@@ -1 +1 @@\n-old\n+new\n',
    );
    const result = run('upstream whypkg', TEST_DIR);
    expect(result.exitCode).toBe(0);
    // encodeURIComponent кодирует пробелы как %20, не как +
    expect(result.stdout).toContain('fix%20a%20critical%20bug');
  });

  test('warns and prints short URL when diff is too long', () => {
    mkdirSync(join(TEST_DIR, 'node_modules', 'bigpkg'), {recursive: true});
    writeFileSync(
      join(TEST_DIR, 'node_modules', 'bigpkg', 'package.json'),
      JSON.stringify({name: 'bigpkg', version: '1.0.0', repository: 'github:acme/bigpkg'}),
    );
    mkdirSync(join(TEST_DIR, 'patches'), {recursive: true});
    // Патч больше 8 КБ — гарантированно не влезет в URL
    const hugeDiff =
      '--- a/node_modules/bigpkg/index.js\n+++ b/node_modules/bigpkg/index.js\n@@ -1 +1 @@\n' +
      '+' + 'x'.repeat(9000) + '\n';
    writeFileSync(join(TEST_DIR, 'patches', 'bigpkg+1.0.0.patch'), hugeDiff);
    const result = run('upstream bigpkg', TEST_DIR);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('too long');
    expect(result.stdout).toContain('paste');
    // Короткий URL всё равно должен присутствовать
    expect(result.stdout).toContain('https://github.com/acme/bigpkg/issues/new');
  });
});

describe('renaming a patch into a sequence', () => {
  const file = () => join(TEST_DIR, 'node_modules', 'is-number', 'index.js');
  const state = () =>
    JSON.parse(readFileSync(join(TEST_DIR, 'node_modules', '.bunch-package-state.json'), 'utf-8'));

  function singleThenAppend() {
    execSync('bun add is-number@7.0.0', {cwd: TEST_DIR, stdio: 'pipe'});
    overwriteFile(file(), `${readFileSync(file(), 'utf-8')}\n// ONE\n`);
    run('create is-number', TEST_DIR);
    run('apply', TEST_DIR);

    const before = state().patches[0];

    overwriteFile(file(), `${readFileSync(file(), 'utf-8')}// TWO\n`);
    run('create is-number --append two', TEST_DIR);

    return before;
  }

  test('the record follows the file, so status does not call the patch missing', () => {
    singleThenAppend();

    expect(state().patches.map((patch: {file: string}) => patch.file)).toEqual([
      'is-number+7.0.0+001+initial.patch',
    ]);

    const shown = run('status', TEST_DIR);
    expect(shown.exitCode).toBe(0);
    expect(shown.stdout).not.toContain('no longer exist');
  });

  test('a record already standing under the new name is not duplicated', () => {
    // Рассинхрон записи с patches/ возможен: файлы правят руками, а запись
    // переживает удаление патча. Тогда при переименовании старое и новое имя
    // оказываются в ней одновременно, и запись получала два элемента с одним
    // именем — `recordedPatches` схлопывает их в Map, поэтому увидеть это можно
    // только в самом файле.
    execSync('bun add is-number@7.0.0', {cwd: TEST_DIR, stdio: 'pipe'});
    overwriteFile(file(), `${readFileSync(file(), 'utf-8')}\n// ONE\n`);
    run('create is-number', TEST_DIR);
    run('apply', TEST_DIR);

    const written = state();
    const stale = {...written.patches[0], file: 'is-number+7.0.0+001+initial.patch'};
    writeFileSync(
      join(TEST_DIR, 'node_modules', '.bunch-package-state.json'),
      JSON.stringify({...written, patches: [...written.patches, stale]}, null, 2),
    );

    overwriteFile(file(), `${readFileSync(file(), 'utf-8')}// TWO\n`);
    run('create is-number --append two', TEST_DIR);

    expect(state().patches.map((patch: {file: string}) => patch.file)).toEqual([
      'is-number+7.0.0+001+initial.patch',
    ]);
  });

  test('the time it first landed survives the rename', () => {
    const before = singleThenAppend();

    const after = state().patches.find((patch: {file: string}) => patch.file.includes('001+initial'));
    expect(after.appliedAt).toBe(before.appliedAt);
    expect(after.sha256).toBe(before.sha256);
  });
});

describe('fold', () => {
  const file = () => join(TEST_DIR, 'node_modules', 'is-number', 'index.js');

  function sequenceOfThree() {
    execSync('bun add is-number@7.0.0', {cwd: TEST_DIR, stdio: 'pipe'});
    const original = readFileSync(file(), 'utf-8');

    overwriteFile(file(), `${original}\n// ONE\n`);
    run('create is-number --why "the first reason"', TEST_DIR);
    run('apply', TEST_DIR);

    overwriteFile(file(), `${readFileSync(file(), 'utf-8')}// TWO\n`);
    run('create is-number --append two --why "the second reason"', TEST_DIR);

    overwriteFile(file(), `${readFileSync(file(), 'utf-8')}// THREE\n`);
    run('create is-number --append three', TEST_DIR);

    return original;
  }

  test('collapses a sequence into one patch that produces the same tree', () => {
    sequenceOfThree();
    const patched = readFileSync(file(), 'utf-8');
    expect(readdirSync(join(TEST_DIR, 'patches'))).toHaveLength(3);

    const result = run('fold is-number', TEST_DIR);
    expect(result.exitCode).toBe(0);

    // Один файл, без номера и метки.
    expect(readdirSync(join(TEST_DIR, 'patches'))).toEqual(['is-number+7.0.0.patch']);
    // Дерево не тронуто самим схлопыванием.
    expect(readFileSync(file(), 'utf-8')).toBe(patched);

    // И то же дерево получается, если применить сложенный патч с нуля.
    expect(run('reverse', TEST_DIR).exitCode).toBe(0);
    expect(readFileSync(file(), 'utf-8')).not.toContain('// ONE');
    expect(run('apply', TEST_DIR).stdout).toContain('1 applied, 0 failed');
    expect(readFileSync(file(), 'utf-8')).toBe(patched);
  });

  test('names the files it is about to delete', () => {
    sequenceOfThree();

    const result = run('fold is-number', TEST_DIR);

    for (const name of ['001+initial', '002+two', '003+three']) {
      expect(result.stdout).toContain(name);
    }
  });

  test('carries the reasons of every patch into the folded one', () => {
    sequenceOfThree();

    run('fold is-number', TEST_DIR);

    const folded = readFileSync(join(TEST_DIR, 'patches', 'is-number+7.0.0.patch'), 'utf-8');
    expect(folded.startsWith('Why: the first reason; the second reason\n\n')).toBe(true);
  });

  test('refuses when a patch of the sequence is not in the tree, and touches nothing', () => {
    sequenceOfThree();
    const before = readdirSync(join(TEST_DIR, 'patches')).sort();
    run('rebase is-number 001+initial', TEST_DIR); // снимаем верхние два

    const result = run('fold is-number', TEST_DIR);

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toContain('not in node_modules right now');
    expect(result.stdout).toContain('002+two');
    expect(readdirSync(join(TEST_DIR, 'patches')).sort()).toEqual(before);
  });

  test('keeps the dev mark of the sequence', () => {
    execSync('bun add is-number@7.0.0', {cwd: TEST_DIR, stdio: 'pipe'});
    const original = readFileSync(file(), 'utf-8');
    overwriteFile(file(), `${original}\n// ONE\n`);
    run('create is-number --dev', TEST_DIR);
    run('apply', TEST_DIR);
    overwriteFile(file(), `${readFileSync(file(), 'utf-8')}// TWO\n`);
    run('create is-number --append two', TEST_DIR);

    expect(run('fold is-number', TEST_DIR).exitCode).toBe(0);

    expect(readdirSync(join(TEST_DIR, 'patches'))).toEqual(['is-number+7.0.0.dev.patch']);
  });

  test('records the folded patch once, and only it', () => {
    sequenceOfThree();
    // Без этого `apply` в записи стоит имя одиночного патча — то самое, каким
    // будет назван схлопнутый. Тогда запись верна и без нашей правки, и тест
    // проходит, ничего не проверяя: проверено мутацией.
    run('apply', TEST_DIR);
    const before = JSON.parse(readFileSync(join(TEST_DIR, 'node_modules', '.bunch-package-state.json'), 'utf-8'));
    expect(before.patches.map((patch: {file: string}) => patch.file)).toHaveLength(3);

    run('fold is-number', TEST_DIR);

    // Смотрим саму запись, а не вывод status: `recordedPatches` раскладывает её
    // в Map по имени файла, и дубль в ней виден только здесь.
    const state = JSON.parse(readFileSync(join(TEST_DIR, 'node_modules', '.bunch-package-state.json'), 'utf-8'));
    expect(state.patches.map((patch: {file: string}) => patch.file)).toEqual(['is-number+7.0.0.patch']);

    const shown = run('status', TEST_DIR);
    expect(shown.exitCode).toBe(0);
    expect(shown.stdout).toContain('1 of 1 in the tree');
    expect(shown.stdout).not.toContain('no longer exist');
  });

  test('does not record the same file twice when the sequence began as a single patch', () => {
    // Последовательность начинается с одиночного патча, и `create --append`
    // переименовывает его в `001+…`, а запись о применённом продолжает хранить
    // прежнее имя — то самое, каким будет назван схлопнутый патч. Здесь и
    // появлялся второй элемент с тем же именем.
    sequenceOfThree();

    run('fold is-number', TEST_DIR);

    const state = JSON.parse(readFileSync(join(TEST_DIR, 'node_modules', '.bunch-package-state.json'), 'utf-8'));
    expect(state.patches.map((patch: {file: string}) => patch.file)).toEqual(['is-number+7.0.0.patch']);
  });

  test('says there is nothing to fold for a single patch, and for none', () => {
    execSync('bun add is-number@7.0.0', {cwd: TEST_DIR, stdio: 'pipe'});
    const original = readFileSync(file(), 'utf-8');

    const none = run('fold is-number', TEST_DIR);
    expect(none.exitCode).not.toBe(0);
    expect(none.stdout).toContain('nothing to fold');

    overwriteFile(file(), `${original}\n// ONE\n`);
    run('create is-number', TEST_DIR);
    const single = run('fold is-number', TEST_DIR);
    expect(single.exitCode).not.toBe(0);
    expect(single.stdout).toContain('nothing to fold');
    expect(existsSync(join(TEST_DIR, 'patches', 'is-number+7.0.0.patch'))).toBe(true);
  });

  test('reports a package that is not installed', () => {
    mkdirSync(join(TEST_DIR, 'node_modules'), {recursive: true});
    const result = run('fold no-such-package', TEST_DIR);
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toContain('not found in node_modules');
  });
});

describe('annotate', () => {
  const file = () => join(TEST_DIR, 'node_modules', 'is-number', 'index.js');

  function threePatches() {
    execSync('bun add is-number@7.0.0', {cwd: TEST_DIR, stdio: 'pipe'});

    overwriteFile(file(), `// FROM ONE\n${readFileSync(file(), 'utf-8')}`);
    run('create is-number', TEST_DIR);
    run('apply', TEST_DIR);

    overwriteFile(file(), readFileSync(file(), 'utf-8').replace('// FROM ONE\n', '// FROM ONE\n// FROM TWO\n'));
    run('create is-number --append two', TEST_DIR);

    overwriteFile(file(), `${readFileSync(file(), 'utf-8')}// FROM THREE\n`);
    run('create is-number --append three', TEST_DIR);
  }

  test('attributes each line to the patch that brought it', () => {
    threePatches();

    const result = run('annotate is-number index.js', TEST_DIR);

    expect(result.exitCode).toBe(0);
    const lines = result.stdout.split('\n');
    expect(lines.find(line => line.includes('// FROM ONE'))).toContain('001');
    expect(lines.find(line => line.includes('// FROM TWO'))).toContain('002');
    expect(lines.find(line => line.includes('// FROM THREE'))).toContain('003');

    // Строка самого пакета не приписана никому.
    const own = lines.find(line => line.includes('module.exports'));
    expect(own).toBeDefined();
    expect(own).not.toMatch(/\b00[123]\b/);

    expect(result.stdout).toContain('3 line(s) from 3 patch(es)');
  });

  test('leaves node_modules exactly as it was', () => {
    threePatches();
    const before = readFileSync(file(), 'utf-8');

    expect(run('annotate is-number index.js', TEST_DIR).exitCode).toBe(0);

    expect(readFileSync(file(), 'utf-8')).toBe(before);
  });

  test('refuses when the file was edited by hand, instead of attributing those lines', () => {
    threePatches();
    overwriteFile(file(), `${readFileSync(file(), 'utf-8')}// EDITED BY HAND\n`);

    const result = run('annotate is-number index.js', TEST_DIR);

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toContain('is not what the patches produce');
    expect(result.stdout).not.toContain('EDITED BY HAND');
  });

  test('refuses when a patch of the sequence is not in the tree', () => {
    threePatches();
    run('rebase is-number 001+initial', TEST_DIR);

    const result = run('annotate is-number index.js', TEST_DIR);

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toContain('is not what the patches produce');
  });

  test('attributes every line of a file a patch created', () => {
    execSync('bun add is-number@7.0.0', {cwd: TEST_DIR, stdio: 'pipe'});
    writeFileSync(join(TEST_DIR, 'node_modules', 'is-number', 'extra.js'), 'const added = 1;\nconst more = 2;\n');
    run('create is-number', TEST_DIR);
    run('apply', TEST_DIR);

    const result = run('annotate is-number extra.js', TEST_DIR);

    expect(result.exitCode).toBe(0);
    for (const text of ['const added = 1;', 'const more = 2;']) {
      expect(result.stdout.split('\n').find(line => line.includes(text))).toContain('001');
    }
  });

  test('says when the package has no patches at all, and when the file is missing', () => {
    execSync('bun add is-number@7.0.0', {cwd: TEST_DIR, stdio: 'pipe'});

    const noPatches = run('annotate is-number index.js', TEST_DIR);
    expect(noPatches.exitCode).not.toBe(0);
    expect(noPatches.stdout).toContain('came with the package');

    overwriteFile(file(), `// ONE\n${readFileSync(file(), 'utf-8')}`);
    run('create is-number', TEST_DIR);
    const noFile = run('annotate is-number nope.js', TEST_DIR);
    expect(noFile.exitCode).not.toBe(0);
    expect(noFile.stdout).toContain('does not exist');
  });

  test('needs both a package and a file', () => {
    const result = run('annotate is-number', TEST_DIR);
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toContain('Usage');
  });
});

// Монорепо: `apply` работает из воркспейса, а пакет, который он патчит, лежит у
// корня. Измерено на bun 1.4.0: при умолчании `packages/*/node_modules/<pkg>` —
// симлинк в `<корень>/node_modules/.bun/…`, при `--linker hoisted` пакет поднят
// в корень и своего node_modules у воркспейса нет вовсе. Раскладку здесь
// строим руками: тест не должен зависеть от того, какой линкер bun выберет
// умолчанием в следующей версии.
describe('monorepo workspaces', () => {
  const LIB = 'shared-lib';

  function monorepo(globs: string[] = ['packages/*'], workspaces: string[] = ['a', 'b']) {
    writeFileSync(join(TEST_DIR, 'package.json'), JSON.stringify({name: 'mono', private: true, workspaces: globs}));
    for (const name of workspaces) {
      mkdirSync(join(TEST_DIR, 'packages', name), {recursive: true});
      writeFileSync(
        join(TEST_DIR, 'packages', name, 'package.json'),
        JSON.stringify({name: `@mono/${name}`, version: '1.0.0'}),
      );
    }
  }

  const workspace = (name: string) => join(TEST_DIR, 'packages', name);

  function patchFor(mark: string): string {
    return `--- a/node_modules/${LIB}/index.js
+++ b/node_modules/${LIB}/index.js
@@ -1 +1 @@
-const a = 1;
+${mark}
`;
  }

  function putPatch(dir: string, mark: string, file = `${LIB}+1.0.0.patch`) {
    mkdirSync(join(dir, 'patches'), {recursive: true});
    writeFileSync(join(dir, 'patches', file), patchFor(mark));
  }

  const libIndex = () => join(TEST_DIR, 'node_modules', LIB, 'index.js');

  test('finds two packages that live in different node_modules in one run', () => {
    // Один пакет поднят в корень монорепо, другой лежит в node_modules самого
    // воркспейса. Место ищется на каждый путь из патча и запоминается — но
    // помнить его надо про пакет, а не про каталог, откуда спросили. Проверено
    // мутацией: ключ без имени пакета — и второй пакет объявляется
    // ненайденным, потому что его ищут там, где нашёлся первый.
    monorepo();
    setupFakePackage(TEST_DIR, 'hoisted-lib', '1.0.0', {'index.js': 'const h = 1;\n'});
    setupFakePackage(workspace('a'), 'local-lib', '1.0.0', {'index.js': 'const l = 1;\n'});

    mkdirSync(join(workspace('a'), 'patches'), {recursive: true});
    for (const [name, before, after] of [['hoisted-lib', 'const h = 1;', 'const h = 2;'], ['local-lib', 'const l = 1;', 'const l = 2;']]) {
      writeFileSync(join(workspace('a'), 'patches', `${name}+1.0.0.patch`),
        `--- a/node_modules/${name}/index.js\n+++ b/node_modules/${name}/index.js\n@@ -1 +1 @@\n-${before}\n+${after}\n`);
    }

    const result = run('apply', workspace('a'));

    expect(result.stdout).toContain('2 applied, 0 failed');
    expect(readFileSync(join(TEST_DIR, 'node_modules', 'hoisted-lib', 'index.js'), 'utf-8')).toBe('const h = 2;\n');
    expect(readFileSync(join(workspace('a'), 'node_modules', 'local-lib', 'index.js'), 'utf-8')).toBe('const l = 2;\n');
  });

  test('applies a patch to a package hoisted to the monorepo root', () => {
    // patch-package #356, самое повторяемое в самом популярном issue соседа:
    // «искать в node_modules родителя». Своего node_modules у воркспейса нет.
    monorepo();
    setupFakePackage(TEST_DIR, LIB, '1.0.0', {'index.js': 'const a = 1;\n'});
    putPatch(workspace('a'), 'const a = 2;');

    const result = run('apply', workspace('a'));

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('1 applied, 0 failed');
    expect(readFileSync(libIndex(), 'utf-8')).toBe('const a = 2;\n');
  });

  test('does not search upwards outside a monorepo', () => {
    // Граница поднимается только внутри монорепо. Обычный проект, лежащий
    // внутри чужого дерева, обязан отвечать как прежде — иначе `apply` начал бы
    // патчить чужие пакеты у соседа по каталогу.
    monorepo();
    writeFileSync(join(TEST_DIR, 'package.json'), JSON.stringify({name: 'not-a-mono', version: '1.0.0'}));
    setupFakePackage(TEST_DIR, LIB, '1.0.0', {'index.js': 'const a = 1;\n'});
    putPatch(workspace('a'), 'const a = 2;');

    const result = run('apply', workspace('a'));

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toContain(`node_modules/${LIB} is not installed`);
    expect(readFileSync(libIndex(), 'utf-8')).toBe('const a = 1;\n');
  });

  test('a stray package.json with workspaces above us is not our root', () => {
    // Забытый манифест с `workspaces` в домашнем каталоге — вещь обычная.
    // Поверив ему на слово, мы сделали бы «проектом» весь `~`.
    monorepo(['apps/*']);
    setupFakePackage(TEST_DIR, LIB, '1.0.0', {'index.js': 'const a = 1;\n'});
    putPatch(workspace('a'), 'const a = 2;');

    const result = run('apply', workspace('a'));

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toContain(`node_modules/${LIB} is not installed`);
  });

  test.skipIf(isWindows)('the store at the monorepo root is not somebody else’s store', () => {
    // Ровно то, на чём инструмент в монорепо не работал вовсе: `.bun` лежит
    // выше cwd воркспейса, и проверка «за пределами проекта» отказывала на
    // каждом патче. DEC-13 объявляет такой стор законным.
    monorepo();
    const store = join(TEST_DIR, 'node_modules', '.bun', `${LIB}@1.0.0`, 'node_modules', LIB);
    mkdirSync(store, {recursive: true});
    writeFileSync(join(store, 'package.json'), JSON.stringify({name: LIB, version: '1.0.0'}));
    writeFileSync(join(store, 'index.js'), 'const a = 1;\n');
    mkdirSync(join(workspace('a'), 'node_modules'), {recursive: true});
    symlinkSync(store, join(workspace('a'), 'node_modules', LIB));
    putPatch(workspace('a'), 'const a = 2;');

    const result = run('apply', workspace('a'));

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('1 applied, 0 failed');
    expect(readFileSync(join(store, 'index.js'), 'utf-8')).toBe('const a = 2;\n');
  });

  test.skipIf(isWindows)('a link out of the monorepo is still refused', () => {
    const outside = `${TEST_DIR}-outside`;
    rmSync(outside, {force: true, recursive: true});
    mkdirSync(join(outside, LIB), {recursive: true});
    writeFileSync(join(outside, LIB, 'package.json'), JSON.stringify({name: LIB, version: '1.0.0'}));
    writeFileSync(join(outside, LIB, 'index.js'), 'const a = 1;\n');

    try {
      monorepo();
      mkdirSync(join(workspace('a'), 'node_modules'), {recursive: true});
      symlinkSync(join(outside, LIB), join(workspace('a'), 'node_modules', LIB));
      putPatch(workspace('a'), 'const a = 2;');

      const result = run('apply', workspace('a'));

      expect(result.exitCode).not.toBe(0);
      expect(result.stdout).toContain("outside the project — that is bun's shared store");
      expect(readFileSync(join(outside, LIB, 'index.js'), 'utf-8')).toBe('const a = 1;\n');
    } finally {
      rmSync(outside, {force: true, recursive: true});
    }
  });

  test('refuses when a sibling workspace patches the same directory differently', () => {
    // Измерено на patch-package 8.0.1: он применяет и молчит, заплата первого
    // оказывается в дереве второго. Отказываем в обоих — исход не должен
    // зависеть от того, кто успел, а bun запускает воркспейсы параллельно.
    monorepo();
    setupFakePackage(TEST_DIR, LIB, '1.0.0', {'index.js': 'const a = 1;\n'});
    putPatch(workspace('a'), 'const a = 2;');
    putPatch(workspace('b'), 'const a = 3;');

    for (const name of ['a', 'b']) {
      const result = run('apply', workspace(name));
      expect(result.exitCode).not.toBe(0);
      expect(result.stdout).toContain('is shared with workspace');
      expect(result.stdout).toContain(`packages/${name === 'a' ? 'b' : 'a'}`);
      expect(result.stdout).toContain('whichever ran last would win');
    }

    expect(readFileSync(libIndex(), 'utf-8')).toBe('const a = 1;\n');
  });

  test('identical patches in two workspaces are not a conflict', () => {
    // Оба воркспейса хотят от общего каталога одного и того же — мешать нечему.
    monorepo();
    setupFakePackage(TEST_DIR, LIB, '1.0.0', {'index.js': 'const a = 1;\n'});
    putPatch(workspace('a'), 'const a = 2;');
    putPatch(workspace('b'), 'const a = 2;');

    expect(run('apply', workspace('a')).stdout).toContain('1 applied, 0 failed');
    expect(run('apply', workspace('b')).stdout).toContain('1 applied, 0 failed');
    expect(readFileSync(libIndex(), 'utf-8')).toBe('const a = 2;\n');
  });

  test('a longer sequence next door is a conflict too', () => {
    // Наборы патчей разной длины дают разные деревья, даже когда первые
    // патчи совпадают побайтово.
    monorepo();
    setupFakePackage(TEST_DIR, LIB, '1.0.0', {'index.js': 'const a = 1;\n'});
    putPatch(workspace('a'), 'const a = 2;', `${LIB}+1.0.0+001+first.patch`);
    putPatch(workspace('b'), 'const a = 2;', `${LIB}+1.0.0+001+first.patch`);
    putPatch(workspace('b'), 'const a = 3;', `${LIB}+1.0.0+002+second.patch`);

    const result = run('apply', workspace('a'));

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toContain('is shared with workspace packages/b');
    expect(readFileSync(libIndex(), 'utf-8')).toBe('const a = 1;\n');
  });

  test('the lock is taken at the monorepo root, not in the workspace', () => {
    // bun запускает postinstall воркспейсов одновременно — измерено, два старта
    // совпали до микросекунды. Пока замок брался от cwd, каждый воркспейс запирал
    // свой файл, и защиты от гонки на общем дереве не было никакой.
    monorepo();
    setupFakePackage(TEST_DIR, LIB, '1.0.0', {'index.js': 'const a = 1;\n'});
    putPatch(workspace('a'), 'const a = 2;');

    const gonePid = spawnSync(process.execPath, ['-e', ''], {stdio: 'ignore'}).pid;
    const rootLock = join(TEST_DIR, 'node_modules', '.bunch-package.lock');
    writeFileSync(rootLock, `${gonePid}\n`);
    const workspaceLock = join(workspace('a'), 'node_modules', '.bunch-package.lock');
    mkdirSync(join(workspace('a'), 'node_modules'), {recursive: true});
    writeFileSync(workspaceLock, `${gonePid}\n`);

    const result = run('apply', workspace('a'));

    expect(result.stdout).toContain('removed a stale lock');
    expect(existsSync(rootLock)).toBe(false);
    // Замок воркспейса не наш: его никто не трогал.
    expect(existsSync(workspaceLock)).toBe(true);
  });

  test('records the applied patch even when the workspace has no node_modules', () => {
    // При поднятых зависимостях каталога node_modules у воркспейса нет, а
    // запись принадлежит ему: она описывает его patches/, а не дерево.
    monorepo();
    setupFakePackage(TEST_DIR, LIB, '1.0.0', {'index.js': 'const a = 1;\n'});
    putPatch(workspace('a'), 'const a = 2;');
    expect(existsSync(join(workspace('a'), 'node_modules'))).toBe(false);

    const result = run('apply', workspace('a'));

    expect(result.stdout).not.toContain('could not write');
    const state = JSON.parse(
      readFileSync(join(workspace('a'), 'node_modules', '.bunch-package-state.json'), 'utf-8'),
    );
    expect(state.patches.map((patch: any) => patch.file)).toEqual([`${LIB}+1.0.0.patch`]);
  });

  test('sees patchedDependencies declared at the monorepo root', () => {
    // Измерено на bun 1.4.0: `patchedDependencies` bun читает и у корня, и у
    // воркспейса, а путь к файлу патча разрешает от корня. Пока мы читали один
    // cwd, из воркспейса корневой список был не виден — и `create` собрал бы
    // патч поверх дерева, куда патч bun уже лёг.
    monorepo();
    setupFakePackage(TEST_DIR, LIB, '1.0.0', {'index.js': 'const a = 1;\n'});
    writeFileSync(
      join(TEST_DIR, 'package.json'),
      JSON.stringify({
        name: 'mono',
        private: true,
        workspaces: ['packages/*'],
        patchedDependencies: {[`${LIB}@1.0.0`]: `patches/${LIB}@1.0.0.patch`},
      }),
    );

    const result = run(`create ${LIB}`, workspace('a'));

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toContain('already patched by bun through patchedDependencies');
  });

  test('export writes the patch path the way bun resolves it — from the root', () => {
    // Измерено на bun 1.4.0: ключ bun чтит и в манифесте воркспейса, а путь к
    // файлу разрешает от корня. `patches/…` оттуда не находится, и установка
    // либо ругается «Couldn't find patch file», либо молча ничего не применяет —
    // а `export` при этом печатал «bun install will now apply them».
    monorepo();
    setupFakePackage(TEST_DIR, LIB, '1.0.0', {'index.js': 'const a = 1;\n'});
    putPatch(workspace('a'), 'const a = 2;');

    expect(run('export', workspace('a')).exitCode).toBe(0);

    const manifest = JSON.parse(readFileSync(join(workspace('a'), 'package.json'), 'utf-8'));
    expect(manifest.patchedDependencies).toEqual({[`${LIB}@1.0.0`]: `packages/a/patches/${LIB}@1.0.0.patch`});
  });

  test('create finds a hoisted package and writes the patch path unchanged', () => {
    // Формат патча от монорепо не меняется: путь в нём как стоял
    // `node_modules/<pkg>/…`, так и стоит, иначе патчи перестали бы ходить
    // между нами и patch-package.
    monorepo();
    execSync('bun add is-number@7.0.0', {cwd: TEST_DIR, stdio: 'pipe'});
    overwriteFile(join(TEST_DIR, 'node_modules', 'is-number', 'index.js'), 'module.exports = "hoisted";\n');

    const result = run('create is-number', workspace('a'));

    expect(result.exitCode).toBe(0);
    const patch = readFileSync(join(workspace('a'), 'patches', 'is-number+7.0.0.patch'), 'utf-8');
    expect(patch).toContain('--- a/node_modules/is-number/index.js');
    expect(patch).toContain('+++ b/node_modules/is-number/index.js');
  });
});

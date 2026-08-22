import {describe, test, expect, beforeEach, afterEach, setDefaultTimeout} from 'bun:test';
import {execSync, spawn, spawnSync} from 'child_process';
import {chmodSync, existsSync, linkSync, lstatSync, mkdirSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync, rmSync, unlinkSync} from 'fs';
import {findLinkDifferences, runDiff, scanTree} from './src/create';
import {withApplyLock} from './src/lock';
import {ensureDir} from './src/paths';
import {invertTarget, parsePatch} from './src/patch-file';
import {join} from 'path';

// writeFileSync пишет в тот же inode, что ломает тесты при hardlink-кеше bun.
// Удаляем файл перед записью, чтобы разорвать hardlink.
function overwriteFile(path: string, content: string) {
  if (existsSync(path)) unlinkSync(path);
  writeFileSync(path, content);
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

function initTestDir() {
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, {force: true, recursive: true});
  }
  mkdirSync(TEST_DIR, {recursive: true});
  writeFileSync(join(TEST_DIR, 'package.json'), JSON.stringify({name: 'test-project', version: '1.0.0'}));
}

beforeEach(() => {
  initTestDir();
});

afterEach(() => {
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, {force: true, recursive: true});
  }
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

import {describe, test, expect, beforeEach, afterEach, setDefaultTimeout} from 'bun:test';
import {execSync} from 'child_process';
import {chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync, rmSync, unlinkSync} from 'fs';
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

const TEST_DIR = join(import.meta.dir, '.test-sandbox');
const CLI = join(import.meta.dir, 'index.ts');

function run(args: string, cwd: string, env?: Record<string, string>): {stdout: string; exitCode: number} {
  try {
    const stdout = execSync(`bun ${CLI} ${args}`, {
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

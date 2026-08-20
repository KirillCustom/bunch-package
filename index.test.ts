import {describe, test, expect, beforeEach, afterEach} from 'bun:test';
import {execSync} from 'child_process';
import {existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, unlinkSync} from 'fs';
import {join} from 'path';

// writeFileSync пишет в тот же inode, что ломает тесты при hardlink-кеше bun.
// Удаляем файл перед записью, чтобы разорвать hardlink.
function overwriteFile(path: string, content: string) {
  if (existsSync(path)) unlinkSync(path);
  writeFileSync(path, content);
}

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

  test('prints the diagnostic from patch when a hunk does not fit', () => {
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

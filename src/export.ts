import {existsSync, readFileSync, renameSync, rmSync, writeFileSync} from 'fs';
import {join, relative, resolve, sep} from 'path';
import {listPatchFiles, parsePatchName} from './patch-file';
import {patchesDirectory} from './paths';
import {workspaceRoot} from './workspace';

// Переписывает пути от корня проекта обратно к корню пакета — точно обратно
// тому, что делает toProjectPaths в import.ts.
// `a/node_modules/pkg/index.js` → `a/index.js`
//
// Почему не пользуемся parsePatch: он разбирает структуру до хунков, а сами
// хунки не трогает. Здесь нам нужно переписать только заголовочные строки —
// тот же контракт, что и у toProjectPaths: тело хунков оставить как есть.
export function toPackagePaths(content: string, name: string): string {
  const prefix = `node_modules/${name}/`;
  const out: string[] = [];

  const strip = (path: string): string => {
    if (path === '/dev/null') return path;
    const pre = path.slice(0, 2); // a/ или b/
    const rest = path.slice(2);   // node_modules/pkg/index.js
    return rest.startsWith(prefix) ? `${pre}${rest.slice(prefix.length)}` : path;
  };

  for (const line of content.split('\n')) {
    const git = line.match(/^diff --git (\S+) (\S+)$/);
    if (git) {
      out.push(`diff --git ${strip(git[1])} ${strip(git[2])}`);
      continue;
    }

    const header = line.match(/^(---|\+\+\+) (\S+)(.*)$/);
    if (header) {
      out.push(`${header[1]} ${strip(header[2])}${header[3]}`);
      continue;
    }

    // git пишет эти пути без префиксов a/ и b/ — симметрично toProjectPaths.
    const rename = line.match(/^rename (from|to) (.+)$/);
    if (rename) {
      const path = rename[2];
      const stripped = path.startsWith(prefix) ? path.slice(prefix.length) : path;
      out.push(`rename ${rename[1]} ${stripped}`);
      continue;
    }

    out.push(line);
  }

  return out.join('\n');
}

// Имя файла в формате bun: `@scope%2Fname@1.2.3.patch` для scoped-пакетов,
// `pkg@1.2.3.patch` для обычных. Обратно тому, что делает fromFileName в import.ts:
// там decodeURIComponent + splitNameAndVersion; здесь — replace + конкатенация.
function toBunFileName(name: string, version: string): string {
  // bun кодирует только '/' — остальные символы, включая '@' в начале
  // scoped-пакета, остаются литералами.
  const encoded = name.replace(/\//g, '%2F');
  return `${encoded}@${version}.patch`;
}

// Путь к файлу патча bun разрешает **от корня воркспейсов**, даже когда сам
// ключ стоит в манифесте воркспейса. Измерено на bun 1.4.0: с воркспейсным
// `patches/ms@2.1.2.patch` установка либо падает «Couldn't find patch file»,
// либо молча ничего не применяет, а тот же ключ с `packages/a/patches/…`
// применяется. То есть `export` из воркспейса писал конфигурацию, которая не
// работает, и печатал «bun install will now apply them».
//
// Вне монорепо ответ прежний, байт в байт: relative от cwd до cwd — пусто.
function manifestPath(patchFile: string): string {
  const root = workspaceRoot() ?? process.cwd();
  const file = resolve(process.cwd(), patchesDirectory(), patchFile);
  return relative(root, file).split(sep).join('/');
}

function readManifestJson(): any {
  if (!existsSync('package.json')) return {};
  try {
    return JSON.parse(readFileSync('package.json', 'utf-8'));
  } catch {
    return {};
  }
}

// Добавляет запись в patchedDependencies и перезаписывает package.json.
// Без этой записи bun при следующей установке патч не найдёт.
function addToManifest(name: string, version: string, patchFile: string): void {
  const manifest = readManifestJson();
  if (typeof manifest.patchedDependencies !== 'object' || manifest.patchedDependencies === null) {
    manifest.patchedDependencies = {};
  }
  manifest.patchedDependencies[`${name}@${version}`] = manifestPath(patchFile);

  const temp = `package.json.bunch-export-${process.pid}`;
  try {
    writeFileSync(temp, `${JSON.stringify(manifest, null, 2)}\n`);
    renameSync(temp, 'package.json');
  } catch (error: any) {
    rmSync(temp, {force: true});
    throw error;
  }
}

export function exportPatches(packageNames: string[]): void {
  if (!existsSync(patchesDirectory())) {
    console.log('📭 No patches directory found');
    return;
  }

  const allFiles = listPatchFiles();
  const filesToProcess =
    packageNames.length > 0
      ? allFiles.filter(file => {
          const parsed = parsePatchName(file);
          return parsed !== null && packageNames.includes(parsed.packageDir);
        })
      : allFiles;

  if (filesToProcess.length === 0) {
    console.log(
      packageNames.length > 0
        ? `📭 No patches found for: ${packageNames.join(', ')}`
        : '📭 No patches to export',
    );
    return;
  }

  // Группируем по имени+версии, чтобы обнаружить последовательности.
  const byPackage = new Map<string, string[]>();
  for (const file of filesToProcess) {
    const parsed = parsePatchName(file);
    if (parsed === null) continue;
    const key = `${parsed.packageDir}@${parsed.version}`;
    if (!byPackage.has(key)) byPackage.set(key, []);
    byPackage.get(key)!.push(file);
  }

  let exported = 0;
  let refused = 0;

  for (const [, files] of byPackage) {
    const parsed = parsePatchName(files[0])!;

    // bun не умеет dev-патчи: у него нет понятия «патч, которого нет в production».
    if (parsed.devOnly) {
      console.log(`  ❌ ${files[0]} — bun does not support dev-only patches`);
      refused++;
      continue;
    }

    // bun не умеет вложенные зависимости — одно имя пакета на патч.
    if (parsed.packageDir.includes('/node_modules/')) {
      console.log(`  ❌ ${files[0]} — bun does not support nested dependencies (${parsed.packageDir})`);
      refused++;
      continue;
    }

    // bun поддерживает только один патч на пакет — последовательности не экспортируются.
    if (files.length > 1 || parsed.sequence > 0) {
      console.log(`  ❌ ${files.join(', ')} — bun supports only one patch per package`);
      refused++;
      continue;
    }

    const file = files[0];
    const content = readFileSync(join(patchesDirectory(), file), 'utf-8');
    const rewritten = toPackagePaths(content, parsed.packageDir);
    const target = toBunFileName(parsed.packageDir, parsed.version);

    // Сначала пишем новый файл, потом убираем старый: половина переноса —
    // состояние, из которого не выбраться.
    writeFileSync(join(patchesDirectory(), target), rewritten);
    if (target !== file) rmSync(join(patchesDirectory(), file), {force: true});

    addToManifest(parsed.packageDir, parsed.version, target);

    console.log(`  ✅ ${file} → ${target}`);
    exported++;
  }

  if (exported === 0) {
    if (refused > 0) console.log(`\n❌ All patches refused — see reasons above`);
    return;
  }

  // Сказать вслух, что теряется при уходе. Без уговоров: факт, не маркетинг.
  console.log('');
  console.log(`📤 ${exported} patch(es) exported to bun's native format`);
  console.log('   bun install will now apply them — no postinstall hook needed.');
  console.log('');
  console.log('   What this tool does that bun patch does not:');
  console.log('   • verifies the lines being removed, not just their positions');
  console.log('   • warns when the installed version drifts from the patch target');
  console.log('   • status, retarget, and patch sequences are not available in bun patch');
}

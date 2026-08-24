import {existsSync, readFileSync, renameSync, rmSync, writeFileSync} from 'fs';
import {basename, join} from 'path';
import {firstPathOutsideNodeModules} from './foreign';
import {formatPatchName, listPatchFiles, parsePatch} from './patch-file';
import {patchesDirectory} from './paths';

// Патчи ходят между инструментами, а форматов в обиходе три. Наш и
// patch-package'овский совпадают: имя `ms+2.1.2.patch`, пути от корня проекта.
// У bun иначе — `ms@2.1.2.patch` (у scoped-пакетов слэш закодирован как %2F), а
// пути внутри от корня пакета. Переписать десяток таких файлов руками никто не
// станет, поэтому переписываем мы.
interface Foreign {
  file: string; // имя файла в patches/
  name: string; // имя пакета
  version: string;
  key: string | null; // ключ в patchedDependencies, если патч записан туда
}

function readManifestJson(): any {
  if (!existsSync('package.json')) return null;
  try {
    return JSON.parse(readFileSync('package.json', 'utf-8'));
  } catch {
    return null;
  }
}

// `@vercel/og@0.4.1` → имя и версия. Разбираем справа: имя scoped-пакета само
// начинается с `@`, поэтому крайний левый `@` версию не отделяет.
function splitNameAndVersion(spec: string): {name: string; version: string} | null {
  const at = spec.lastIndexOf('@');
  if (at <= 0) return null;

  const name = spec.slice(0, at);
  const version = spec.slice(at + 1);
  return name === '' || version === '' ? null : {name, version};
}

function fromFileName(file: string): {name: string; version: string} | null {
  if (!file.endsWith('.patch')) return null;
  return splitNameAndVersion(decodeURIComponent(file.slice(0, -'.patch'.length)));
}

// Секция служебного файла, который bun заводит себе на время правки. В дереве
// пакета ему делать нечего.
function isBunTag(path: string): boolean {
  return basename(path).startsWith('.bun-tag-');
}

// Пути от корня пакета → пути от корня проекта. Тело хунков не трогаем: там
// может быть что угодно, включая строки, похожие на заголовки.
export function toProjectPaths(content: string, name: string): string {
  const prefix = `node_modules/${name}/`;
  const out: string[] = [];
  let dropping = false;

  const absolute = (path: string): string => (path === '/dev/null' ? path : `${path.slice(0, 2)}${prefix}${path.slice(2)}`);

  for (const line of content.split('\n')) {
    const git = line.match(/^diff --git (\S+) (\S+)$/);
    if (git) {
      dropping = isBunTag(git[1]) || isBunTag(git[2]);
      if (!dropping) out.push(`diff --git ${absolute(git[1])} ${absolute(git[2])}`);
      continue;
    }

    if (dropping) continue;

    const header = line.match(/^(---|\+\+\+) (\S+)(.*)$/);
    if (header) {
      out.push(`${header[1]} ${absolute(header[2])}${header[3]}`);
      continue;
    }

    // git пишет эти пути без префиксов a/ и b/.
    const rename = line.match(/^rename (from|to) (.+)$/);
    if (rename) {
      out.push(`rename ${rename[1]} ${prefix}${rename[2]}`);
      continue;
    }

    out.push(line);
  }

  return out.join('\n');
}

function collect(): Foreign[] {
  const manifest = readManifestJson();
  const patched: Record<string, string> =
    manifest?.patchedDependencies !== null && typeof manifest?.patchedDependencies === 'object'
      ? manifest.patchedDependencies
      : {};

  const found: Foreign[] = [];
  const seen = new Set<string>();

  for (const [key, value] of Object.entries(patched)) {
    if (typeof value !== 'string') continue;
    const parts = splitNameAndVersion(key);
    const file = basename(value);
    if (parts === null || !existsSync(join(patchesDirectory(), file))) continue;

    found.push({file, name: parts.name, version: parts.version, key});
    seen.add(file);
  }

  // Файл могли записать в patches/ и не прописать в package.json — тогда
  // единственный признак чужого формата это пути внутри.
  for (const file of listPatchFiles()) {
    if (seen.has(file)) continue;

    const targets = parsePatch(readFileSync(join(patchesDirectory(), file), 'utf-8'));
    if (targets.length === 0 || firstPathOutsideNodeModules(targets) === undefined) continue;

    const parts = fromFileName(file);
    if (parts === null) continue;
    found.push({file, name: parts.name, version: parts.version, key: null});
  }

  return found;
}

export function importPatches(): void {
  if (!existsSync(patchesDirectory())) {
    console.log('📭 No patches directory found');
    return;
  }

  const foreign = collect();
  if (foreign.length === 0) {
    console.log('✅ Nothing to import — every patch here is already in this tool’s format');
    return;
  }

  console.log(`📥 Importing ${foreign.length} patch(es)...`);

  const imported: Foreign[] = [];

  for (const patch of foreign) {
    const path = join(patchesDirectory(), patch.file);
    const content = readFileSync(path, 'utf-8');

    if (firstPathOutsideNodeModules(parsePatch(content)) === undefined) {
      console.log(`  ⏭  ${patch.file} — already in this tool’s format`);
      continue;
    }

    const target = formatPatchName({packageDir: patch.name, version: patch.version});
    const rewritten = toProjectPaths(content, patch.name);

    // Сначала пишем новый файл, потом убираем старый: половина переноса —
    // состояние, из которого не выбраться.
    writeFileSync(join(patchesDirectory(), target), rewritten);
    if (target !== patch.file) rmSync(path, {force: true});

    console.log(`  ✅ ${patch.file} → ${target}`);
    imported.push(patch);
  }

  if (imported.length === 0) return;

  dropFromManifest(imported);

  console.log('');
  console.log(`📊 ${imported.length} patch(es) now belong to bunch-package`);
  console.log(`   Run \`bunch-package apply\` after your next install — bun no longer applies them.`);
}

// Запись в patchedDependencies надо убрать: файла под старым именем больше нет,
// и bun при следующей установке спотыкался бы о него.
function dropFromManifest(imported: Foreign[]): void {
  const keys = imported.map(patch => patch.key).filter((key): key is string => key !== null);
  if (keys.length === 0) return;

  const manifest = readManifestJson();
  if (manifest?.patchedDependencies === undefined || manifest.patchedDependencies === null) return;

  for (const key of keys) delete manifest.patchedDependencies[key];
  if (Object.keys(manifest.patchedDependencies).length === 0) delete manifest.patchedDependencies;

  const temp = `package.json.bunch-import-${process.pid}`;
  try {
    writeFileSync(temp, `${JSON.stringify(manifest, null, 2)}\n`);
    renameSync(temp, 'package.json');
  } catch (error: any) {
    rmSync(temp, {force: true});
    throw error;
  }

  console.log(`  📝 removed ${keys.length} entr${keys.length === 1 ? 'y' : 'ies'} from patchedDependencies`);
}

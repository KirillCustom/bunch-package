import {existsSync, readFileSync, renameSync, rmSync, writeFileSync} from 'fs';
import {basename, join, relative, resolve} from 'path';
import {workspaceRoot} from './workspace';
import {firstPathOutsideNodeModules} from './foreign';
import {formatPatchName, listPatchFiles, parsePatch} from './patch-file';
import {patchesDirectory} from './paths';

// Патчи ходят между инструментами, а форматов в обиходе три. Наш и
// patch-package'овский совпадают: имя `ms+2.1.2.patch`, пути от корня проекта.
// У bun иначе — `ms@2.1.2.patch` (у scoped-пакетов слэш закодирован как %2F), а
// пути внутри от корня пакета. Переписать десяток таких файлов руками никто не
// станет, поэтому переписываем мы.
interface Foreign {
  file: string; // имя файла патча
  dir: string; // каталог, где файл лежит: наш patches/ или корневой
  name: string; // имя пакета
  version: string;
  key: string | null; // ключ в patchedDependencies, если патч записан туда
  manifest: string | null; // манифест, где стоит этот ключ
}

function readManifestJson(path: string = 'package.json'): any {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return null;
  }
}

// Манифесты, где bun ищет patchedDependencies: свой и, внутри монорепо,
// корневой. Измерено на bun 1.4.0 (NOT-25): ключ он берёт у обоих, а путь к
// файлу разрешает всегда от корня воркспейсов. Пока import читал один лишь
// cwd, запись у корня он не видел вовсе и молчал: «Nothing to import».
function manifestPaths(): string[] {
  const root = workspaceRoot();
  if (root === null || resolve(root) === resolve(process.cwd())) return ['package.json'];
  return ['package.json', join(root, 'package.json')];
}

function patchedIn(manifest: string): Record<string, string> {
  const parsed = readManifestJson(manifest);
  const value = parsed?.patchedDependencies;
  if (value === null || typeof value !== 'object') return {};

  return Object.fromEntries(
    Object.entries(value).filter((pair): pair is [string, string] => typeof pair[1] === 'string'),
  );
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

// Где лежит файл патча: у себя или там, куда его кладёт bun — от корня
// воркспейсов. Второе встречается ровно потому, что путь в манифесте bun
// разрешает от корня, даже когда сам ключ стоит в манифесте воркспейса.
function locatePatchFile(value: string): string | null {
  const file = basename(value);
  if (existsSync(join(patchesDirectory(), file))) return patchesDirectory();

  const root = workspaceRoot();
  if (root === null) return null;

  const atRoot = join(root, value);
  return existsSync(atRoot) ? join(atRoot, '..') : null;
}

function collect(): Foreign[] {
  const found: Foreign[] = [];
  const seen = new Set<string>();

  for (const manifest of manifestPaths()) {
    for (const [key, value] of Object.entries(patchedIn(manifest))) {
      const parts = splitNameAndVersion(key);
      const dir = locatePatchFile(value);
      if (parts === null || dir === null) continue;

      const file = basename(value);
      if (seen.has(file)) continue;

      found.push({file, dir, name: parts.name, version: parts.version, key, manifest});
      seen.add(file);
    }
  }

  // Файл могли записать в patches/ и не прописать в package.json — тогда
  // единственный признак чужого формата это пути внутри.
  for (const file of listPatchFiles()) {
    if (seen.has(file)) continue;

    const targets = parsePatch(readFileSync(join(patchesDirectory(), file), 'utf-8'));
    if (targets.length === 0 || firstPathOutsideNodeModules(targets) === undefined) continue;

    const parts = fromFileName(file);
    if (parts === null) continue;
    found.push({file, dir: patchesDirectory(), name: parts.name, version: parts.version, key: null, manifest: null});
  }

  return found;
}

export function importPatches(): void {
  if (!existsSync(patchesDirectory())) {
    console.log('📭 No patches directory found');
    return;
  }

  const foreign = collect();

  // Патч, объявленный у корня монорепо, применяется всему дереву, а не одному
  // воркспейсу. Перенести его отсюда в свой patches/ значило бы молча отобрать
  // его у соседей — поэтому мы такие называем, а берёмся только за свои.
  const ours = foreign.filter(patch => patch.manifest === null || isOurManifest(patch.manifest));
  const elsewhere = foreign.filter(patch => !ours.includes(patch));

  if (ours.length === 0) {
    console.log(
      elsewhere.length === 0
        ? '✅ Nothing to import — every patch here is already in this tool’s format'
        : `✅ Nothing to import here`,
    );
    reportElsewhere(elsewhere);
    return;
  }

  console.log(`📥 Importing ${ours.length} patch(es)...`);

  const imported: Foreign[] = [];

  for (const patch of ours) {
    const path = join(patch.dir, patch.file);
    const content = readFileSync(path, 'utf-8');

    if (firstPathOutsideNodeModules(parsePatch(content)) === undefined) {
      console.log(`  ⏭  ${patch.file} — already in this tool’s format`);
      continue;
    }

    const target = formatPatchName({packageDir: patch.name, version: patch.version});
    const rewritten = toProjectPaths(content, patch.name);

    // Сначала пишем новый файл, потом убираем старый: половина переноса —
    // состояние, из которого не выбраться. Новый пишется всегда в наш каталог,
    // а старый бывает и у корня: путь к нему bun разрешает оттуда.
    const written = join(patchesDirectory(), target);
    writeFileSync(written, rewritten);
    if (resolve(written) !== resolve(path)) rmSync(path, {force: true});

    console.log(`  ✅ ${patch.file} → ${target}`);
    imported.push(patch);
  }

  if (imported.length === 0) return;

  dropFromManifest(imported);

  console.log('');
  console.log(`📊 ${imported.length} patch(es) now belong to bunch-package`);
  console.log(`   Run \`bunch-package apply\` after your next install — bun no longer applies them.`);
  reportElsewhere(elsewhere);
}

function isOurManifest(path: string): boolean {
  return resolve(path) === resolve('package.json');
}

// Молчать о них нельзя: человек пришёл сюда именно за тем, чтобы патчей bun в
// проекте не осталось, а эти никуда не делись — просто объявлены не здесь.
function reportElsewhere(elsewhere: Foreign[]): void {
  if (elsewhere.length === 0) return;

  const root = workspaceRoot();
  console.log('');
  console.log(`🏠 ${elsewhere.length} patch(es) are declared in the monorepo root manifest, not here:`);
  for (const patch of elsewhere) console.log(`   ${patch.file} (${patch.key})`);
  console.log(`   They apply to the whole tree, so import them from the root:`);
  console.log(`     cd ${root === null ? '<monorepo root>' : relative(process.cwd(), root) || '.'} && bunch-package import`);
}

// Запись в patchedDependencies надо убрать: файла под старым именем больше нет,
// и bun при следующей установке спотыкался бы о него.
function dropFromManifest(imported: Foreign[]): void {
  const keys = imported.filter((patch): patch is Foreign & {key: string; manifest: string} =>
    patch.key !== null && patch.manifest !== null);
  if (keys.length === 0) return;

  const manifest = readManifestJson();
  if (manifest?.patchedDependencies === undefined || manifest.patchedDependencies === null) return;

  for (const patch of keys) delete manifest.patchedDependencies[patch.key];
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

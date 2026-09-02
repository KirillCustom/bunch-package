import {execFileSync} from 'child_process';
import {readFileSync} from 'fs';
import {join} from 'path';
import {readManifest, validatePackageName} from './create';
import {listPatchFiles, parsePatchName, splitPatchHeader, patchHeaderField} from './patch-file';
import {patchesDirectory} from './paths';

// GitHub обрезает длинные адреса — issue открывается пустым вместо заполненного.
// Предел не задокументирован, но воспроизводится при ~8192 байт в адресной строке.
const GITHUB_URL_LIMIT = 8192;

// Три формы поля `repository` в package.json, все ведущие на GitHub:
//   github:org/repo           — явный шортенд npm
//   https://github.com/org/repo.git — полный URL
//   git+ssh://git@github.com/org/repo.git — SSH с обёрткой
//   org/repo                  — короткая запись: npm документирует её как GitHub
//
// Возвращает GitHub-URL для поддерживаемых форм или {external: url} для остальных.
// null означает «поле отсутствует или не распознано».
export function parseRepository(
  repo: unknown,
): {github: string; owner: string; repoName: string} | {external: string} | null {
  if (repo === null || repo === undefined) return null;

  // `repository` бывает строкой или объектом {type, url}. Нам нужен URL.
  const raw =
    typeof repo === 'object' && repo !== null && 'url' in repo
      ? String((repo as Record<string, unknown>).url)
      : String(repo);

  if (!raw || raw.trim() === '') return null;

  // github:org/repo
  if (raw.startsWith('github:')) {
    const path = raw.slice('github:'.length).replace(/\.git$/, '');
    const slash = path.indexOf('/');
    if (slash > 0 && slash < path.length - 1) {
      const owner = path.slice(0, slash);
      const name = path.slice(slash + 1);
      if (isValidSlug(owner) && isValidSlug(name)) {
        return {github: `https://github.com/${owner}/${name}`, owner, repoName: name};
      }
    }
  }

  // Полные URL: https://, git+https://, git+ssh://, ssh://, git@
  const githubUrl = raw.match(
    /^(?:git\+)?(?:https?:\/\/|ssh:\/\/git@|git@)github\.com[/:]([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/i,
  );
  if (githubUrl) {
    const owner = githubUrl[1];
    const name = githubUrl[2];
    return {github: `https://github.com/${owner}/${name}`, owner, repoName: name};
  }

  // Короткая запись org/repo (npm документирует её как GitHub-шортенд)
  const short = raw.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/);
  if (short) {
    const owner = short[1];
    const name = short[2];
    return {github: `https://github.com/${owner}/${name}`, owner, repoName: name};
  }

  // Не-GitHub: извлекаем URL, чтобы показать его пользователю
  const externalUrl = raw.match(/^(?:git\+)?(https?:\/\/\S+)/);
  if (externalUrl) return {external: externalUrl[1].replace(/\.git$/, '')};

  // Что-то ещё: SSH без схемы, file://, и т.п.
  return {external: raw};
}

function isValidSlug(s: string): boolean {
  return /^[A-Za-z0-9_.-]+$/.test(s);
}

// Читает package.json пакета из node_modules и возвращает поле `repository`.
function readPackageRepository(packagePath: string): unknown {
  const json = JSON.parse(readFileSync(join(packagePath, 'package.json'), 'utf-8')) as Record<
    string,
    unknown
  >;
  return json.repository ?? null;
}

// Ищет первый патч-файл для пакета. Если их несколько (последовательность) —
// берёт все, чтобы тело issue содержало полный дифф.
function patchContentFor(packageName: string, version: string): string | null {
  const files = listPatchFiles();
  const matching = files.filter(file => {
    const parsed = parsePatchName(file);
    return parsed !== null && parsed.packageDir === packageName && parsed.version === version;
  });
  if (matching.length === 0) return null;

  return matching
    .map(file => readFileSync(join(patchesDirectory(), file), 'utf-8'))
    .join('\n');
}

// Открывает браузер через нативную команду платформы — без зависимостей.
// execFileSync без shell: аргументы не интерпретируются шеллом.
//
// На Windows URL содержит `&` между параметрами (`?title=…&body=…`). Для
// cmd.exe `&` — разделитель команд, и `start "" url` передаёт его через
// разбор аргументов cmd, где экранирование зависит от реализации рантайма.
// После CVE-2024-27980 Node.js добавил защиту, поведение bun неизвестно.
// explorer.exe принимает URL напрямую, без шелла-посредника, — так `&` не
// интерпретируется вовсе.
function openBrowser(url: string): void {
  if (process.platform === 'darwin') execFileSync('open', [url]);
  else if (process.platform === 'win32') execFileSync('explorer.exe', [url]);
  else execFileSync('xdg-open', [url]);
}

export function upstreamIssue(packageName: string, open: boolean): void {
  // `create` проверяет имя по той же причине: без этого `../..` попадает прямо
  // в join('node_modules', ...) и читает файлы за пределами проекта.
  validatePackageName(packageName);

  const packagePath = join('node_modules', packageName);

  // Пакет установлен?
  let manifest: {name: string; version: string};
  try {
    manifest = readManifest(packagePath);
  } catch {
    throw new Error(`${packageName} is not installed — run \`bun install\` first`);
  }

  const repoRaw = readPackageRepository(packagePath);
  const repo = parseRepository(repoRaw);

  if (repo === null) {
    throw new Error(
      `${packageName} has no \`repository\` field in its package.json — cannot generate an issue URL`,
    );
  }

  if ('external' in repo) {
    console.log(`${packageName} uses a non-GitHub repository:`);
    console.log(repo.external);
    console.log('Open it in the browser and file an issue there manually.');
    return;
  }

  const patchContent = patchContentFor(packageName, manifest.version);
  const {header} = patchContent !== null ? splitPatchHeader(patchContent) : {header: ''};
  const why = header !== '' ? patchHeaderField(header, 'Why') : null;
  const upstream = header !== '' ? patchHeaderField(header, 'Upstream') : null;

  const title = `Patch for ${manifest.name}@${manifest.version}`;

  // Тело issue: сначала контекст (зачем, ссылка), потом дифф в блоке кода.
  const contextLines: string[] = [];
  if (why !== null && why !== '') contextLines.push(`**Why:** ${why}`);
  if (upstream !== null && upstream !== '') contextLines.push(`**Upstream reference:** ${upstream}`);
  contextLines.push(`**Package version:** ${manifest.name}@${manifest.version}`);

  const bodyWithDiff =
    patchContent !== null
      ? `${contextLines.join('\n')}\n\n<details>\n<summary>Patch</summary>\n\n\`\`\`diff\n${patchContent}\`\`\`\n</details>`
      : contextLines.join('\n');

  const bodyWithoutDiff = contextLines.join('\n') + '\n\n*(paste the patch here)*';

  const issueBase = `${repo.github}/issues/new`;
  const fullUrl = `${issueBase}?title=${encodeURIComponent(title)}&body=${encodeURIComponent(bodyWithDiff)}`;

  if (fullUrl.length > GITHUB_URL_LIMIT) {
    // URL обрезался бы GitHub — лучше честно сказать и дать короткий вариант.
    const shortUrl = `${issueBase}?title=${encodeURIComponent(title)}&body=${encodeURIComponent(bodyWithoutDiff)}`;
    console.log(`The patch is too long to fit in a URL (${fullUrl.length} characters, limit ${GITHUB_URL_LIMIT}).`);
    console.log('Open this URL and paste the patch manually:\n');
    console.log(shortUrl);
    if (open) openBrowser(shortUrl);
    return;
  }

  console.log(fullUrl);
  if (open) openBrowser(fullUrl);
}

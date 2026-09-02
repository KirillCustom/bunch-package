import {existsSync, readFileSync} from 'fs';
import {PatchTarget, parsePatchName} from './patch-file';
import {packageDirectoryOf, packageInstalled, stripPathPrefix} from './paths';

// Патч с суффиксом `.dev.patch` относится к пакету, которого в production нет:
// его ставят только с devDependencies. Отказывать из-за такого патча на
// production-установке — значит валить деплой из-за инструмента разработки.
//
// Правило целиком повторяет patch-package (`getInstalledPackageVersion`): пропуск
// случается только при `NODE_ENV=production`. В разработке devDependencies стоят,
// и отсутствующий пакет означает сломанную установку, о которой надо сказать.
export function inProduction(): boolean {
  return process.env.NODE_ENV === 'production';
}

// Всё правило целиком, одним ответом: пропустить ли патч, у которого нет
// пакета. Держать его в одном месте важнее, чем сэкономить строку у вызывающих:
// пока `NODE_ENV` проверялся и здесь, и в apply, снятие одной из двух проверок
// ничего не меняло — то есть проверка была не закреплена ничем.
export function skipsMissingPackage(patchFile: string): boolean {
  if (!inProduction()) return false;

  const parsed = parsePatchName(patchFile);
  if (parsed === null) return false;

  // Либо суффикс в имени, либо пакет записан в devDependencies корневого
  // манифеста. Второе — тоже как у patch-package.
  // У вложенной зависимости в devDependencies записан внешний пакет.
  return parsed.devOnly || isDevDependency(parsed.packageDir.split('/node_modules/')[0]);
}

function isDevDependency(name: string): boolean {
  if (!existsSync('package.json')) return false;

  try {
    const {devDependencies} = JSON.parse(readFileSync('package.json', 'utf-8'));
    return devDependencies !== null && typeof devDependencies === 'object' && name in devDependencies;
  } catch {
    return false;
  }
}

// Каталоги пакетов, которых нет на диске. Спрашивается это до планирования:
// план у отсутствующего пакета всё равно не сойдётся, а сказать надо не «хунк
// не подошёл», а «пакета нет» — и для дев-патча вовсе промолчать.
export function missingPackages(targets: PatchTarget[]): string[] {
  const missing: string[] = [];

  for (const target of targets) {
    for (const raw of [target.newPath ?? target.oldPath]) {
      if (raw === null || raw === undefined) continue;

      const directory = packageDirectoryOf(stripPathPrefix(raw));
      if (directory === null || packageInstalled(directory) || missing.includes(directory)) continue;
      missing.push(directory);
    }
  }

  return missing;
}

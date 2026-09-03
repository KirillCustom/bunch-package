import {existsSync, readFileSync} from 'fs';
import {basename, join, resolve} from 'path';
import {PatchTarget} from './patch-file';
import {packageDirectoryOf, stripPathPrefix} from './paths';
import {workspaceRoot} from './workspace';

// bun с 1.2 патчит пакеты сам: `bun patch --commit` кладёт файл в тот же
// patches/ и записывает его в `patchedDependencies` package.json. Применяет его
// установщик, а не postinstall.
//
// Такой патч — не наш, и браться за него нельзя: пути в нём от корня пакета
// (`a/index.js`), а не от корня проекта (`a/node_modules/ms/index.js`). Мы
// срезаем `a/` и решаем путь от корня проекта, то есть били бы по файлам самого
// проекта. Проверено на bun 1.4.0: `apply` переписывал ./index.js проекта и
// печатал `✅ 1 applied`.
//
// В монорепо список читается из двух манифестов. Измерено на bun 1.4.0: ключ
// `patchedDependencies` bun берёт и у корня, и у воркспейса, а путь к файлу
// патча разрешает всегда от корня — воркспейсный `patches/ms@2.1.2.patch` дал
// «Couldn't find patch file», тот же файл у корня применился. Читай мы только
// cwd, из воркспейса корневой список был бы не виден: `create` собрал бы патч
// поверх дерева, куда патч bun уже лёг, и унёс бы его изменения в себя — ровно
// тот отказ, ради которого эта проверка написана.
function patchedDependencies(): Record<string, string> {
  const root = workspaceRoot();
  const manifests = ['package.json'];
  if (root !== null && resolve(root) !== resolve(process.cwd())) {
    manifests.push(join(root, 'package.json'));
  }

  return Object.assign({}, ...manifests.map(declaredIn));
}

function declaredIn(manifest: string): Record<string, string> {
  if (!existsSync(manifest)) return {};

  try {
    const value = JSON.parse(readFileSync(manifest, 'utf-8')).patchedDependencies;
    if (value === null || typeof value !== 'object') return {};

    return Object.fromEntries(
      Object.entries(value).filter((pair): pair is [string, string] => typeof pair[1] === 'string'),
    );
  } catch {
    // Битый package.json — не повод ронять apply: без этого списка чужой патч
    // всё равно не пройдёт проверку путей ниже.
    return {};
  }
}

// Файлы в patches/, которые применяет bun. Их мы не трогаем вовсе.
export function patchesAppliedByBun(): Set<string> {
  return new Set(Object.values(patchedDependencies()).map(file => basename(file)));
}

// Патчит ли bun этот пакет сам. Спрашивает create: два механизма на один пакет
// дерутся — наш патч считался бы от дерева, куда буновский уже лёг, и унёс бы
// его изменения в себя.
export function bunAlsoPatches(name: string): boolean {
  return Object.keys(patchedDependencies()).some(key => key.startsWith(`${name}@`));
}

// Последний рубеж на случай, когда патч чужого формата в `patchedDependencies`
// не записан: и наш `create`, и patch-package пишут пути от корня проекта,
// начиная с `node_modules/`. Всё остальное — не наше дело, и молча бить по
// файлам проекта мы не станем.
// Один и тот же текст у apply и у отката: расходиться в объяснении одного и
// того же отказа — значит дважды объяснять его по-разному. Так же живёт
// outsideProjectReason рядом со своей проверкой.
export function foreignPatchReason(path: string): string {
  return (
    `${path} is not inside node_modules/ — this looks like a \`bun patch\` patch, whose paths ` +
    `are relative to the package root. bun applies those itself; list it in patchedDependencies, ` +
    `or recreate it with \`bunch-package create\`.`
  );
}

export function firstPathOutsideNodeModules(targets: PatchTarget[]): string | undefined {
  // Путь, уходящий за пределы проекта, — другой разговор, и его ведёт
  // resolveInsideProject: там и диагноз точнее, и проверка старше этой.
  const escapes = (path: string) => path.startsWith('/') || path.split('/').includes('..');

  const foreign = (path: string): boolean => !escapes(path) && packageDirectoryOf(path) === null;

  for (const target of targets) {
    for (const raw of [target.oldPath, target.newPath]) {
      if (raw === null) continue;
      const relative = stripPathPrefix(raw);
      if (foreign(relative)) return relative;
    }

    // Пути переименования git пишет уже без префиксов a/ и b/.
    for (const raw of [target.renameFrom, target.renameTo]) {
      if (raw !== null && foreign(raw)) return raw;
    }
  }

  return undefined;
}

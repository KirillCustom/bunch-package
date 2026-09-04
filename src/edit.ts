import {existsSync, readFileSync, readdirSync, realpathSync, statSync} from 'fs';
import {join, relative, sep} from 'path';
import {readManifest, validatePackageName} from './create';
import {bunAlsoPatches} from './foreign';
import {lockFile, withApplyLock} from './lock';
import {atomicWrite, installedPackagePath, packageNotFoundError, realPathOutsideProject, TEMP_WRITE_SUFFIX} from './paths';

// Правка файла в node_modules меняет запись общего кеша bun. Измерено на 1.4.0:
// при `--backend=hardlink` (умолчание Linux) у файла в node_modules и у файла в
// ~/.bun/install/cache один инод, дописанная строка появляется в кеше сразу же,
// и следующая чистая установка в любом другом проекте на машине приезжает уже
// с чужой заплатой. На macOS с clonefile этого нет — там копия своя.
//
// create от этого защищён своим кешем эталона, поэтому диффы у нас верные;
// испорчен кеш пользователя, и молча. bun решает это тем же способом: `bun
// patch` перед выдачей пакета на правку перезаписывает папку копией из кеша
// («cuz it could be hardlinked»), pnpm и yarn правки в node_modules не дают
// вовсе. Мы были единственными, кто оставлял этот шаг человеку.
function detachTree(root: string): {detached: number; scanned: number} {
  let detached = 0;
  let scanned = 0;

  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, {withFileTypes: true})) {
      const path = join(dir, entry.name);

      if (entry.isDirectory()) {
        walk(path);
        continue;
      }
      // Всё, что не обычный файл, проходит мимо. Прежде всего симлинки: они не
      // хранят содержимого, разрывать в них нечего, а пройти по ссылке значило
      // бы положить на место ссылки обычный файл. Заодно сюда попадают сокеты и
      // очереди — читать их нельзя, а появись такое в пакете, тишина дешевле
      // отказа всей команды.
      if (!entry.isFile()) continue;
      // Сосед, оставшийся от убитого apply: он и так наш и одиноким инодом.
      if (entry.name.includes(TEMP_WRITE_SUFFIX)) continue;

      scanned++;
      const stat = statSync(path);
      // Инод с одной ссылкой уже наш собственный: копировать его — только менять
      // время правки на ровном месте.
      if (stat.nlink <= 1) continue;

      // Содержимое читаем байтами: в пакете лежат .node, .wasm и картинки, и
      // строка через utf-8 вернула бы вместо них замещающие символы.
      atomicWrite(path, readFileSync(path), stat.mode & 0o7777);
      detached++;
    }
  };

  walk(root);
  return {detached, scanned};
}

export function editPackage(packageName: string): void {
  validatePackageName(packageName);

  const packagePath = installedPackagePath(packageName);
  if (!existsSync(packagePath)) {
    throw packageNotFoundError(packageName);
  }

  const {name, version} = readManifest(packagePath);

  // Пакет, который патчит bun, править этой командой бессмысленно: его патч
  // накладывает установщик, и create такой пакет всё равно не возьмёт.
  if (bunAlsoPatches(name)) {
    throw new Error(
      `${name} is already patched by bun through patchedDependencies.\n` +
        `   Edit it with \`bun patch ${name}\`, or run \`bunch-package import\` to take the patch over.`,
    );
  }

  // Изолированная раскладка (`bun install --linker isolated`) кладёт сюда
  // симлинк на node_modules/.bun/…; у bun бывает и вариант, где эта цепочка
  // уходит в общий стор внутри кеша. Разрывать хардлинки там нельзя — писать мы
  // будем уже в сам стор, то есть ровно в то, от чего команда защищает.
  const shared = realPathOutsideProject(`node_modules/${packageName}`);
  if (shared !== null) {
    throw new Error(
      `node_modules/${packageName} resolves to ${shared}, which is outside the project.\n` +
        `   That is bun's shared store: editing there changes ${name} for every project on this machine.\n` +
        `   Reinstall with the store inside the project (BUN_INSTALL_GLOBAL_STORE=0 bun install),\n` +
        `   or get a private copy with \`bun patch ${name}\`.`,
    );
  }

  const real = realpathSync(packagePath);

  console.log(`✂️  Detaching ${name}@${version} from the shared cache...`);

  // Под тем же замком, что и apply: apply пишет файлы через временный и
  // перестановку, и если он положит новую версию файла между нашим чтением и
  // нашей перестановкой, мы вернём на место старую — то есть снимем только что
  // применённый патч, ничего об этом не сказав.
  const {detached, scanned} = withApplyLock(lockFile(), () => detachTree(real));

  if (detached === 0) {
    console.log(`✅ Nothing to detach — all ${scanned} file(s) are already private copies`);
    console.log(`   bun links packages from its shared cache on some platforms and copies them on others.`);
  } else {
    console.log(`✅ Detached ${detached} of ${scanned} file(s) from bun's cache`);
  }

  // В монорепо пакет может быть поднят к корню, и своего node_modules у
  // воркспейса тогда нет вовсе: советовать «правь node_modules/<pkg>» значило бы
  // называть путь, которого здесь не существует.
  console.log(`\nNow edit ${relative(process.cwd(), packagePath).split(sep).join('/')}, then run:`);
  console.log(`  bunch-package create ${packageName}`);
}

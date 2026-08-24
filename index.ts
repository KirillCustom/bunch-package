#!/usr/bin/env bun

import {applyPatches} from './src/apply';
import {createPatch} from './src/create';
import {importPatches} from './src/import';
import {rebasePatches} from './src/rebase';
import {retargetPatches} from './src/retarget';
import {showStatus} from './src/status';

// Main
const command = process.argv[2];
const arg = process.argv[3];

// --append <метка> заводит следующий патч в последовательности вместо того,
// чтобы переписать существующий.
function parseAppendLabel(argv: string[]): string | null {
  const at = argv.indexOf('--append');
  if (at === -1) return null;

  const label = argv[at + 1];
  if (!label || !/^[\w.-]+$/.test(label)) {
    console.error('❌ --append needs a name made of letters, digits, dots, dashes or underscores');
    process.exit(1);
  }
  return label;
}

// Имя пакета требуют три команды из пяти, и одинаково: пустое место — забытый
// аргумент, `--flag` на этом месте — тоже он, только флаг уехал вперёд имени.
function requirePackageName(usage: string): string {
  if (!arg || arg.startsWith('--')) {
    console.error(`❌ Usage: ${usage}`);
    process.exit(1);
  }
  return arg;
}

// Сообщения об отказах написаны, чтобы их прочитал человек: «поставьте
// diffutils», «поднимите BUNCH_FETCH_TIMEOUT». Без этой обёртки они выходили
// стеком необработанного исключения — то есть тем видом, в котором текст не
// читают вовсе.
//
// Обёртка одна на весь разбор: пока их было по одной на команду, следующая
// команда легко оставалась без своей, и признаком этого был бы стек.
try {
  switch (command) {
    case 'create':
      createPatch(
        requirePackageName('bunch-package create <package-name> [--append <name>]'),
        parseAppendLabel(process.argv),
      );
      break;

    case 'apply':
      applyPatches();
      break;

    case 'retarget':
      retargetPatches(requirePackageName('bunch-package retarget <package-name>'));
      break;

    case 'status':
      showStatus();
      break;

    case 'import':
      importPatches();
      break;

    case 'rebase': {
      // Цель обязательна и без умолчания: «откатить на что-нибудь» — не команда.
      const usage = 'bunch-package rebase <package-name> <patch-file|number|0>';
      const packageName = requirePackageName(usage);
      const target = process.argv[4];
      if (!target) {
        console.error(`❌ Usage: ${usage}`);
        process.exit(1);
      }

      rebasePatches(packageName, target);
      break;
    }

    default:
      console.log(`
🎯 bunch-package - Patch management for Bun

Commands:
  bunch-package create <package>                  Create or update a patch
  bunch-package create <package> --append <name>  Add another patch to the package
  bunch-package apply                             Apply all patches
  bunch-package status                            Show which patches are in the tree
  bunch-package rebase <package> <patch|0>        Un-apply the patches that sit on top of one
  bunch-package retarget <package>                Move its patches to the installed version
  bunch-package import                            Convert patches written by \`bun patch\` to this format
    `);
  }
} catch (error: any) {
  console.error(`❌ ${error?.message ?? error}`);
  process.exit(1);
}

#!/usr/bin/env bun

import {applyPatches} from './src/apply';
import {createPatch} from './src/create';
import {importPatches} from './src/import';
import {filtersOf, parseOptions} from './src/options';
import {usePatchesDirectory} from './src/paths';
import {rebasePatches, reverseAll} from './src/rebase';
import {retargetPatches} from './src/retarget';
import {showStatus} from './src/status';

// Main
const command = process.argv[2];

// Сообщения об отказах написаны, чтобы их прочитал человек: «поставьте
// diffutils», «поднимите BUNCH_FETCH_TIMEOUT». Без этой обёртки они выходили
// стеком необработанного исключения — то есть тем видом, в котором текст не
// читают вовсе.
//
// Обёртка одна на весь разбор: пока их было по одной на команду, следующая
// команда легко оставалась без своей, и признаком этого был бы стек.
try {
  const options = parseOptions(process.argv.slice(3));
  if (options.patchDir !== null) usePatchesDirectory(options.patchDir);

  // Имя пакета требуют три команды из шести, и одинаково: пустое место —
  // забытый аргумент.
  const requirePackages = (usage: string): string[] => {
    if (options.packages.length === 0) {
      console.error(`❌ Usage: ${usage}`);
      process.exit(1);
    }
    return options.packages;
  };

  switch (command) {
    case 'create': {
      // Несколько пакетов за раз: правка часто задевает пару соседних, и
      // разбираться, какой из них не сошёлся, лучше по общему отчёту, чем по
      // трём запускам подряд. Поэтому отказ на одном не отменяет остальных.
      const names = requirePackages('bunch-package create <package-name>... [--append <name>]');
      const filters = filtersOf(options);
      let failed = 0;

      for (const name of names) {
        try {
          createPatch(name, options.append, filters, options.dev);
        } catch (error: any) {
          console.error(`❌ ${error?.message ?? error}`);
          failed++;
        }
      }

      if (failed > 0) process.exit(1);
      break;
    }

    case 'apply':
      applyPatches(options.errorOnWarn);
      break;

    case 'reverse':
      reverseAll();
      break;

    case 'import':
      importPatches();
      break;

    case 'retarget':
      retargetPatches(requirePackages('bunch-package retarget <package-name>')[0]);
      break;

    case 'status':
      showStatus();
      break;

    case 'rebase': {
      // Цель обязательна и без умолчания: «откатить на что-нибудь» — не команда.
      const usage = 'bunch-package rebase <package-name> <patch-file|number|0>';
      const [packageName, target] = requirePackages(usage);
      if (target === undefined) {
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
  bunch-package create <package>...               Create or update a patch
  bunch-package create <package> --append <name>  Add another patch to the package
  bunch-package create <package> --dev             Mark it as needed only in development
  bunch-package apply                             Apply all patches
  bunch-package reverse                           Un-apply all of them
  bunch-package status                            Show which patches are in the tree
  bunch-package rebase <package> <patch|0>        Un-apply the patches that sit on top of one
  bunch-package retarget <package>                Move its patches to the installed version
  bunch-package import                            Convert patches written by \`bun patch\` to this format

Options:
  --patch-dir <dir>                               Where the patches live (default: patches)
  --include <regexp>, --exclude <regexp>          Which paths go into a patch, from the package root
  --case-sensitive-path-filtering                 Match those two case-sensitively
  --error-on-warn                                 Make \`apply\` exit 1 after a warning too
    `);
  }
} catch (error: any) {
  console.error(`❌ ${error?.message ?? error}`);
  process.exit(1);
}

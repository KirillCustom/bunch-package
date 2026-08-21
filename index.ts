#!/usr/bin/env bun

import {applyPatches} from './src/apply';
import {createPatch} from './src/create';
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

// Сообщения об отказах написаны, чтобы их прочитал человек: «поставьте
// diffutils», «поднимите BUNCH_FETCH_TIMEOUT». Без этой обёртки они выходили
// стеком необработанного исключения — то есть тем видом, в котором текст не
// читают вовсе.
function fail(error: any): never {
  console.error(`❌ ${error?.message ?? error}`);
  process.exit(1);
}

switch (command) {
  case 'create':
    if (!arg || arg.startsWith('--')) {
      console.error('❌ Usage: bunch-package create <package-name> [--append <name>]');
      process.exit(1);
    }

    try {
      createPatch(arg, parseAppendLabel(process.argv));
    } catch (error) {
      fail(error);
    }
    break;

  case 'apply':
    try {
      applyPatches();
    } catch (error) {
      fail(error);
    }
    break;

  case 'retarget':
    if (!arg || arg.startsWith('--')) {
      console.error('❌ Usage: bunch-package retarget <package-name>');
      process.exit(1);
    }

    try {
      retargetPatches(arg);
    } catch (error) {
      fail(error);
    }
    break;

  case 'status':
    try {
      showStatus();
    } catch (error) {
      fail(error);
    }
    break;

  case 'rebase': {
    // Цель обязательна и без умолчания: «откатить на что-нибудь» — не команда.
    const target = process.argv[4];
    if (!arg || arg.startsWith('--') || !target) {
      console.error('❌ Usage: bunch-package rebase <package-name> <patch-file|number|0>');
      process.exit(1);
    }

    try {
      rebasePatches(arg, target);
    } catch (error) {
      fail(error);
    }
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
    `);
}

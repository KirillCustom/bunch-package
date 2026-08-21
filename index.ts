#!/usr/bin/env bun

import {applyPatches} from './src/apply';
import {createPatch} from './src/create';

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

switch (command) {
  case 'create':
    if (!arg || arg.startsWith('--')) {
      console.error('❌ Usage: bunch-package create <package-name> [--append <name>]');
      process.exit(1);
    }

    createPatch(arg, parseAppendLabel(process.argv));
    break;

  case 'apply':
    applyPatches();
    break;

  default:
    console.log(`
🎯 bunch-package - Patch management for Bun

Commands:
  bunch-package create <package>                  Create or update a patch
  bunch-package create <package> --append <name>  Add another patch to the package
  bunch-package apply                             Apply all patches
    `);
}

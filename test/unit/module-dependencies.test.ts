/**
 * The direction of the dependencies between the modules of `src/`
 * (`ARCHITECTURE.md` § Organização do código): `health` → `wagering` →
 * `wallet` → `messaging` → `shared`, and no module imports the composition
 * root. Read from the import statements of every file, type-only ones included.
 *
 * @packageDocumentation
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { Glob } from 'bun';

const SRC = resolve(import.meta.dir, '../../src');

/** What each module may import besides itself; anything else under `src/` is the composition root. */
const ALLOWED: Record<string, readonly string[]> = {
  shared: [],
  messaging: ['shared'],
  wallet: ['messaging', 'shared'],
  wagering: ['wallet', 'messaging', 'shared'],
  health: ['wagering', 'wallet', 'messaging', 'shared'],
};
const MODULES = Object.keys(ALLOWED);

const IMPORT = /(?:import|export)\s[^;]*?from\s+'(\.[^']+)'/g;

/** @returns Every relative import of the module's files, as `file -> target top-level entry`. */
function importsOf(module: string): { file: string; target: string }[] {
  const found: { file: string; target: string }[] = [];
  for (const path of new Glob('**/*.ts').scanSync(join(SRC, module))) {
    const file = join(SRC, module, path);
    for (const [, specifier] of readFileSync(file, 'utf8').matchAll(IMPORT)) {
      const target = relative(SRC, resolve(dirname(file), specifier!)).split(sep)[0]!;
      found.push({ file: relative(SRC, file).split(sep).join('/'), target });
    }
  }
  return found;
}

describe('module dependencies', () => {
  test.each(MODULES)('%s imports only the modules inside it, never the composition root', (module) => {
    const allowed = new Set([module, ...ALLOWED[module]!]);

    const violations = importsOf(module)
      .filter(({ target }) => !allowed.has(target))
      .map(({ file, target }) => `${file} -> ${target}`);

    expect(violations).toEqual([]);
  });
});

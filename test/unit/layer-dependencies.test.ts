/**
 * The direction of the dependencies between the layers of each module of
 * `src/` (`ARCHITECTURE.md` § Organização do código): `domain/` imports no
 * external package and no outer layer, of any module; `application/` imports
 * no `infrastructure/` nor `interface/`, and only the external packages listed
 * in {@link APPLICATION_PACKAGES}. Read from the import statements of every
 * file, type-only, side-effect and dynamic ones included.
 *
 * @packageDocumentation
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { Glob } from 'bun';

const SRC = resolve(import.meta.dir, '../../src');

/** The external packages `application/` may import — the explicit exceptions to "no external package". */
const APPLICATION_PACKAGES: readonly string[] = ['node:crypto'];

/** The layers each layer must not import, in its own module or in any other. */
const FORBIDDEN_LAYERS: Record<'domain' | 'application', readonly string[]> = {
  domain: ['application', 'infrastructure', 'interface'],
  application: ['infrastructure', 'interface'],
};

/** The external packages each layer may import; anything else outside `src/` is a violation. */
const ALLOWED_PACKAGES: Record<'domain' | 'application', readonly string[]> = {
  domain: [],
  application: APPLICATION_PACKAGES,
};

const IMPORT = /(?:import|export)\s[^;]*?from\s+['"]([^'"]+)['"]|import\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g;

/** @returns Every import specifier of the files under `src/<module>/<layer>/`, with the importing file. */
function importsOf(layer: string): { file: string; specifier: string }[] {
  const found: { file: string; specifier: string }[] = [];
  for (const path of new Glob(`*/${layer}/**/*.ts`).scanSync(SRC)) {
    const file = join(SRC, path);
    for (const match of readFileSync(file, 'utf8').matchAll(IMPORT)) {
      const specifier = (match[1] ?? match[2] ?? match[3])!;
      found.push({ file: relative(SRC, file).split(sep).join('/'), specifier });
    }
  }
  return found;
}

/** @returns Why the import breaks the layer rule, or `undefined` when it is allowed. */
function violation(layer: 'domain' | 'application', file: string, specifier: string): string | undefined {
  if (!specifier.startsWith('.')) {
    return ALLOWED_PACKAGES[layer].includes(specifier) ? undefined : 'external package';
  }
  const targetLayer = relative(SRC, resolve(dirname(join(SRC, file)), specifier)).split(sep)[1];
  return targetLayer !== undefined && FORBIDDEN_LAYERS[layer].includes(targetLayer)
    ? `${targetLayer} layer`
    : undefined;
}

describe('layer dependencies', () => {
  test.each(['domain', 'application'] as const)('%s imports no forbidden layer nor package', (layer) => {
    const violations = importsOf(layer).flatMap(({ file, specifier }) => {
      const reason = violation(layer, file, specifier);
      return reason === undefined ? [] : [`${file} -> ${specifier} (${reason})`];
    });

    expect(violations).toEqual([]);
  });
});

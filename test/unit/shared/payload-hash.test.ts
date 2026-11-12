/**
 * Unit tests for the payload hash: SHA-256 of a canonical JSON.
 *
 * @packageDocumentation
 */
import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { canonicalJson, hashPayload } from '../../../src/shared/application/payload-hash.ts';

describe('canonicalJson', () => {
  test('sorts keys recursively and has no whitespace', () => {
    expect(canonicalJson({ b: 1, a: { d: 'x', c: [2, { f: true, e: null }] } })).toBe(
      '{"a":{"c":[2,{"e":null,"f":true}],"d":"x"},"b":1}',
    );
  });

  test('omits absent fields instead of writing null', () => {
    expect(canonicalJson({ a: 'x', reference: undefined })).toBe('{"a":"x"}');
  });

  test('escapes strings as JSON does', () => {
    expect(canonicalJson({ name: 'aspas " e ç' })).toBe('{"name":"aspas \\" e ç"}');
  });
});

describe('hashPayload', () => {
  test('is the lowercase hex SHA-256 of the canonical JSON, whatever the key order', () => {
    const expected = createHash('sha256').update('{"a":"1","b":"2"}', 'utf8').digest('hex');

    expect(hashPayload({ b: '2', a: '1' })).toBe(expected);
    expect(hashPayload({ a: '1', b: '2' })).toMatch(/^[0-9a-f]{64}$/);
  });
});

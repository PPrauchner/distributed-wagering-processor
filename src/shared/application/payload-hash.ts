/**
 * Payload hash: SHA-256, in lowercase hex, of a canonical JSON — keys sorted
 * recursively, no whitespace, UTF-8, absent fields omitted (never `null`). One
 * function for every input that needs a payload fingerprint (`ARCHITECTURE.md`
 * § Hash do payload).
 *
 * @packageDocumentation
 */
import { createHash } from 'node:crypto';

/** A JSON value; `undefined` object fields are absent fields. */
export type CanonicalValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | readonly CanonicalValue[]
  | { readonly [key: string]: CanonicalValue };

/**
 * @param value - The value to serialize.
 * @returns Its canonical JSON.
 */
export function canonicalJson(value: CanonicalValue): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const record = value as { readonly [key: string]: CanonicalValue };
    const fields = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
    return `{${fields.join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

/**
 * @param value - The business fields of a payload.
 * @returns The SHA-256 of their canonical JSON, 64 lowercase hex characters.
 */
export function hashPayload(value: CanonicalValue): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

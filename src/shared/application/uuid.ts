/**
 * The shape of a UUID, checked before an id reaches the database.
 *
 * @packageDocumentation
 */

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** @returns Whether `value` is a UUID in its canonical textual form, any case. */
export function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

/**
 * Error for a request body that does not follow the endpoint's contract.
 *
 * @packageDocumentation
 */

export class InvalidPayloadError extends Error {
  override readonly name = 'InvalidPayloadError';
}

/**
 * Narrows `value` to a plain object holding exactly `allowedKeys`, all present.
 *
 * @param value - The untrusted value.
 * @param allowedKeys - The only keys the object may and must have.
 * @param path - Where the value sits in the body, for the error message.
 * @returns The value as a record.
 * @throws {@link InvalidPayloadError} If it is not an object, misses a key or has an unknown one.
 */
export function expectExactObject(
  value: unknown,
  allowedKeys: readonly string[],
  path: string,
): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new InvalidPayloadError(`${path} must be an object`);
  }
  const record = value as Record<string, unknown>;
  const unknownKey = Object.keys(record).find((key) => !allowedKeys.includes(key));
  if (unknownKey !== undefined) {
    throw new InvalidPayloadError(`${path}.${unknownKey} is not a known field`);
  }
  const missingKey = allowedKeys.find((key) => !(key in record));
  if (missingKey !== undefined) {
    throw new InvalidPayloadError(`${path}.${missingKey} is required`);
  }
  return record;
}

/**
 * @param value - The untrusted value.
 * @param path - Where the value sits in the body, for the error message.
 * @returns The value as a string.
 * @throws {@link InvalidPayloadError} If it is not a string.
 */
export function expectString(value: unknown, path: string): string {
  if (typeof value !== 'string') throw new InvalidPayloadError(`${path} must be a string`);
  return value;
}

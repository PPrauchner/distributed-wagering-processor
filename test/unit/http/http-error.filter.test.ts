/**
 * Unit tests for the global HTTP error filter's answers to infrastructure
 * failures: every failure code it answers with is one of the closed
 * `FailureCode` set, documented in `ARCHITECTURE.md` § Códigos de falha.
 *
 * @packageDocumentation
 */
import { describe, expect, test } from 'bun:test';
import type { ArgumentsHost } from '@nestjs/common';
import { HttpErrorFilter } from '../../../src/http/http-error.filter.ts';
import {
  PermanentFailureError,
  TransientFailureError,
} from '../../../src/shared/application/infrastructure-failures.ts';
import { FailureCode } from '../../../src/shared/domain/failure-code.ts';

interface Answer {
  status?: number;
  body?: unknown;
  headers: Record<string, string>;
}

async function answerTo(error: unknown): Promise<Answer> {
  const answer: Answer = { headers: {} };
  const response = {
    setHeader: (name: string, value: string) => {
      answer.headers[name] = value;
    },
    status: (code: number) => {
      answer.status = code;
      return { json: (body: unknown) => (answer.body = body) };
    },
  };
  const request = { method: 'GET', path: '/', body: undefined, headers: {} };
  const host = {
    switchToHttp: () => ({ getResponse: () => response, getRequest: () => request }),
  } as unknown as ArgumentsHost;
  await new HttpErrorFilter({ retryAfterSeconds: 7 }).catch(error, host);
  return answer;
}

describe('HttpErrorFilter', () => {
  test('a transient failure → 503 with its code and the configured Retry-After', async () => {
    const answer = await answerTo(new TransientFailureError(FailureCode.TransientLockTimeout));

    expect(answer).toEqual({
      status: 503,
      body: { failureCode: 'TRANSIENT_LOCK_TIMEOUT', message: expect.any(String) },
      headers: { 'Retry-After': '7' },
    });
  });

  test('a permanent failure without a transaction → 500 with its code', async () => {
    const answer = await answerTo(new PermanentFailureError(FailureCode.InfraInvariantViolation));

    expect(answer).toMatchObject({ status: 500, body: { failureCode: 'INFRA_INVARIANT_VIOLATION' } });
  });

  test('an unknown error → 500 INFRA_UNEXPECTED, never a code out of the closed set', async () => {
    const answer = await answerTo(new TypeError('a bug'));

    expect(answer).toEqual({
      status: 500,
      body: { failureCode: 'INFRA_UNEXPECTED', message: 'internal error' },
      headers: {},
    });
  });
});

/**
 * Unit tests for how `ProcessWagerTransaction` times a submission that did not
 * end in a transaction: only a refusal of the submission is `not_admitted`;
 * an error nobody translated — a bug — is `permanent`, never a refusal.
 *
 * @packageDocumentation
 */
import { describe, expect, test } from 'bun:test';
import type { ContextLog } from '../../../src/shared/application/context-log.ts';
import type { UnitOfWork } from '../../../src/shared/application/unit-of-work.ts';
import {
  ProcessWagerTransaction,
  type SubmitWagerTransactionCommand,
} from '../../../src/wagering/application/process-wager-transaction.ts';
import { IdempotencyConflictError } from '../../../src/wagering/application/wagering-errors.ts';
import type {
  ProcessingFailureObservation,
  WageringMetrics,
} from '../../../src/wagering/application/wagering-metrics.ts';
import { SubmissionChannel } from '../../../src/wagering/domain/rejected-submission.ts';

const COMMAND: SubmitWagerTransactionCommand = {
  idempotencyKey: 'provider-a:transaction-123',
  providerId: 'provider-a',
  externalTransactionId: 'transaction-123',
  playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1',
  walletId: '0192f291-27dd-7d3f-8071-5f8685deef37',
  roundId: 'round-987',
  gameId: 'fortune-chimp',
  kind: 'BET',
  money: { amount: '10.00', currency: 'BRL' },
};

const log: ContextLog = {
  inContext: (_fields, work) => work(),
  enrich: () => undefined,
  info: () => undefined,
  warn: () => undefined,
};

/** Runs a submission whose unit of work throws `error`; returns the failures it timed. */
async function failuresTimedFor(error: Error): Promise<ProcessingFailureObservation[]> {
  const failures: ProcessingFailureObservation[] = [];
  const metrics: WageringMetrics = {
    transactionSettled: () => undefined,
    processingFailed: (observation) => void failures.push(observation),
    idempotencyConflict: () => undefined,
    lockConflict: () => undefined,
    submissionNotAdmitted: () => undefined,
    pendingReferenceResolved: () => undefined,
    pendingReferenceRetried: () => undefined,
  };
  const throwing = {
    run: async () => {
      throw error;
    },
  } as unknown as UnitOfWork<never>;
  const useCase = new ProcessWagerTransaction(throwing, () => crypto.randomUUID(), metrics, log, {
    ttlMs: 60_000,
    backoff: { baseMs: 1000, maxMs: 5000 },
  });

  await expect(useCase.execute(COMMAND, SubmissionChannel.Http)).rejects.toBe(error);
  return failures;
}

describe('a submission that did not end in a transaction', () => {
  test('refused by its key is timed not_admitted', async () => {
    const failures = await failuresTimedFor(new IdempotencyConflictError('provider-a', 'k', 'a'.repeat(64)));

    expect(failures.map((failure) => failure.outcome)).toEqual(['not_admitted']);
  });

  test('ended by an error nobody translated is timed permanent, not as a refusal', async () => {
    const failures = await failuresTimedFor(new TypeError('cannot read properties of undefined'));

    expect(failures.map((failure) => failure.outcome)).toEqual(['permanent']);
  });
});

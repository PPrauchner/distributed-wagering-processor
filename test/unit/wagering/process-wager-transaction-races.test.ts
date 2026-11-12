/**
 * Unit tests for how `ProcessWagerTransaction` settles a commit that hit the
 * provider's external id: it reads the transaction recorded first back, in the
 * order of the validations — key, then external id —, never trusting which
 * unique index PostgreSQL happened to check first. The race is provoked
 * directly, with a unit of work that fails the first commit.
 *
 * @packageDocumentation
 */
import { describe, expect, test } from 'bun:test';
import type { ContextLog } from '../../../src/shared/application/context-log.ts';
import type { UnitOfWork } from '../../../src/shared/application/unit-of-work.ts';
import { Money } from '../../../src/shared/domain/money.ts';
import {
  ProcessWagerTransaction,
  type SubmitWagerTransactionCommand,
} from '../../../src/wagering/application/process-wager-transaction.ts';
import { hashWagerPayload } from '../../../src/wagering/application/wager-payload.ts';
import {
  DuplicateExternalIdError,
  ExternalIdConflictError,
  IdempotencyConflictError,
} from '../../../src/wagering/application/wagering-errors.ts';
import type { WageringMetrics } from '../../../src/wagering/application/wagering-metrics.ts';
import { SubmissionChannel } from '../../../src/wagering/domain/rejected-submission.ts';
import { WagerTransaction, WagerTransactionKind } from '../../../src/wagering/domain/wager-transaction.ts';

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

const metrics: WageringMetrics = {
  transactionSettled: () => undefined,
  processingFailed: () => undefined,
  idempotencyConflict: () => undefined,
  lockConflict: () => undefined,
  submissionNotAdmitted: () => undefined,
  pendingReferenceResolved: () => undefined,
  pendingReferenceRetried: () => undefined,
};

/** The transaction a concurrent submission committed under the command's external id. */
function committedFirst(overrides: { idempotencyKey?: string; amount?: string } = {}): WagerTransaction {
  const money = Money.from({ amount: overrides.amount ?? COMMAND.money.amount, currency: COMMAND.money.currency });
  const payload = {
    providerId: COMMAND.providerId,
    externalTransactionId: COMMAND.externalTransactionId,
    playerId: COMMAND.playerId,
    walletId: COMMAND.walletId,
    roundId: COMMAND.roundId,
    gameId: COMMAND.gameId,
    kind: WagerTransactionKind.Bet,
    money,
  };
  return WagerTransaction.create({
    ...payload,
    id: crypto.randomUUID(),
    idempotencyKey: overrides.idempotencyKey ?? COMMAND.idempotencyKey,
    payloadHash: hashWagerPayload(payload),
    correlationId: crypto.randomUUID(),
  });
}

/**
 * Submits the command through a unit of work whose first commit hits the
 * external id — `earlier` won the race — and whose later ones read `earlier`.
 */
function submitLosingTheRaceTo(earlier: WagerTransaction) {
  let runs = 0;
  const transactions = {
    findByIdempotencyKey: async (providerId: string, key: string) =>
      providerId === earlier.providerId && key === earlier.idempotencyKey ? earlier : undefined,
    findByExternalId: async (providerId: string, externalId: string) =>
      providerId === earlier.providerId && externalId === earlier.externalTransactionId ? earlier : undefined,
  };
  const unitOfWork = {
    run: async (work: (repositories: unknown) => Promise<unknown>) => {
      runs += 1;
      if (runs === 1) throw new DuplicateExternalIdError('duplicate key value violates "uq_external_id"');
      return work({ transactions });
    },
  } as unknown as UnitOfWork<never>;
  const useCase = new ProcessWagerTransaction(unitOfWork, () => crypto.randomUUID(), metrics, log, {
    ttlMs: 60_000,
    backoff: { baseMs: 1000, maxMs: 5000 },
  });
  return useCase.execute(COMMAND, SubmissionChannel.Http);
}

describe('a commit that hit the external id', () => {
  test('of a transaction with the same key and payload is a replay', async () => {
    const earlier = committedFirst();

    const outcome = await submitLosingTheRaceTo(earlier);

    expect(outcome).toEqual({ transaction: earlier, idempotentReplay: true });
  });

  test('of a transaction with another key is an external id conflict', async () => {
    const earlier = committedFirst({ idempotencyKey: 'provider-a:another-key' });

    await expect(submitLosingTheRaceTo(earlier)).rejects.toBeInstanceOf(ExternalIdConflictError);
  });

  test('of a transaction with the same key and another payload is an idempotency conflict', async () => {
    const earlier = committedFirst({ amount: '20.00' });

    await expect(submitLosingTheRaceTo(earlier)).rejects.toBeInstanceOf(IdempotencyConflictError);
  });
});

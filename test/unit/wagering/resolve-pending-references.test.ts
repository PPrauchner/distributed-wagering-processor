/**
 * Unit tests for `ResolvePendingReferences`: with no caller to tell, an error
 * the classifier left unclassified — or one in recording the item's failure —
 * is isolated to its item, and the rest of the batch goes on.
 *
 * @packageDocumentation
 */
import { describe, expect, test } from 'bun:test';
import type { OutboxRepositories } from '../../../src/messaging/application/outbox-repository.ts';
import type { ContextLog } from '../../../src/shared/application/context-log.ts';
import type { FaultInjection } from '../../../src/shared/application/fault-injector.ts';
import type { UnitOfWork } from '../../../src/shared/application/unit-of-work.ts';
import { FailureCode } from '../../../src/shared/domain/failure-code.ts';
import type { WalletRepositories } from '../../../src/wallet/application/wallet-repository.ts';
import { ResolvePendingReferences } from '../../../src/wagering/application/resolve-pending-references.ts';
import type { WageringRepositories } from '../../../src/wagering/application/wager-transaction-repository.ts';
import { WagerTransactionStatus, type WagerTransaction } from '../../../src/wagering/domain/wager-transaction.ts';

type Repositories = WalletRepositories & WageringRepositories & OutboxRepositories & FaultInjection;

const POISON = 'tx-poison';
const HEALTHY = 'tx-healthy';

/**
 * A database holding two due pending references: the poison one throws an
 * unexpected error when its wallet is locked; the healthy one is found
 * resolved meanwhile. Records the wallets locked and the failures recorded.
 */
function database(options: { failureRecordingFails?: boolean } = {}): {
  unitOfWork: UnitOfWork<Repositories>;
  locked: string[];
  failed: { id: string; code: FailureCode }[];
} {
  const locked: string[] = [];
  const failed: { id: string; code: FailureCode }[] = [];
  const pending = (id: string): WagerTransaction =>
    ({
      id,
      status: WagerTransactionStatus.PendingReference,
      fail: (code: FailureCode) => void failed.push({ id, code }),
    }) as unknown as WagerTransaction;
  const repositories = {
    wallets: {
      findByIdForUpdate: async (walletId: string) => {
        locked.push(walletId);
        if (walletId === `w-${POISON}`) throw new Error('a bug nobody classified');
        return null;
      },
    },
    transactions: {
      claimDuePendingReferences: async () => [
        { transactionId: POISON, walletId: `w-${POISON}` },
        { transactionId: HEALTHY, walletId: `w-${HEALTHY}` },
      ],
      findById: async (id: string) => {
        if (options.failureRecordingFails) throw new Error('the failure could not be recorded either');
        return pending(id);
      },
    },
    faults: { inject: async () => undefined },
  } as unknown as Repositories;
  return { unitOfWork: { run: (work) => work(repositories) }, locked, failed };
}

function logSpy(): ContextLog & { warnings: string[] } {
  const warnings: string[] = [];
  return {
    warnings,
    inContext: (_fields, work) => work(),
    enrich: () => undefined,
    info: () => undefined,
    warn: (line) => void warnings.push(line),
  };
}

function resolver(unitOfWork: UnitOfWork<Repositories>, log: ContextLog): ResolvePendingReferences {
  return new ResolvePendingReferences(unitOfWork, () => 'generated-id', {
    leaseMs: 30_000,
    referenceWait: { ttlMs: 300_000, backoff: { baseMs: 1000, maxMs: 60_000 } },
  }, log);
}

describe('an unexpected error in resolving a pending reference', () => {
  test('records it FAILED INFRA_UNEXPECTED, with an alert, and the batch goes on', async () => {
    const { unitOfWork, locked, failed } = database();
    const log = logSpy();

    const claimed = await resolver(unitOfWork, log).resolveDue();

    expect(claimed).toBe(2);
    expect(failed).toEqual([{ id: POISON, code: FailureCode.InfraUnexpected }]);
    expect(locked).toEqual([`w-${POISON}`, `w-${HEALTHY}`]);
    expect(log.warnings).toHaveLength(1);
  });

  test('one in recording the failure is logged, and the batch goes on', async () => {
    const { unitOfWork, locked } = database({ failureRecordingFails: true });
    const log = logSpy();

    const claimed = await resolver(unitOfWork, log).resolveDue();

    expect(claimed).toBe(2);
    expect(locked).toEqual([`w-${POISON}`, `w-${HEALTHY}`]);
    expect(log.warnings.length).toBeGreaterThan(0);
  });
});

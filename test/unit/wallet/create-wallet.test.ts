/**
 * `CreateWallet` on its failure path: a lock conflict the unit of work
 * classified — the creation lost to a concurrent one — is counted by its
 * reason and still reaches the caller; another transient failure is not
 * counted as a lock conflict.
 *
 * @packageDocumentation
 */
import { describe, expect, test } from 'bun:test';
import type { OutboxRepositories } from '../../../src/messaging/application/outbox-repository.ts';
import {
  TransientFailureError,
  type LockConflictReason,
} from '../../../src/shared/application/infrastructure-failures.ts';
import type { UnitOfWork } from '../../../src/shared/application/unit-of-work.ts';
import { FailureCode } from '../../../src/shared/domain/failure-code.ts';
import type { WageringRepositories } from '../../../src/wagering/application/wager-transaction-repository.ts';
import { RecordOpening } from '../../../src/wagering/application/record-opening.ts';
import { CreateWallet } from '../../../src/wallet/application/create-wallet.ts';
import type { WalletRepositories } from '../../../src/wallet/application/wallet-repository.ts';

type Repositories = WalletRepositories & WageringRepositories & OutboxRepositories;

function failingWith(error: Error): UnitOfWork<Repositories> {
  return {
    run: async () => {
      throw error;
    },
  };
}

function createWallet(unitOfWork: UnitOfWork<Repositories>, conflicts: LockConflictReason[]): CreateWallet {
  return new CreateWallet(unitOfWork, new RecordOpening(() => Bun.randomUUIDv7()), () => Bun.randomUUIDv7(), {
    lockConflict: (reason) => void conflicts.push(reason),
  });
}

const command = { playerId: '0192f291-27dd-7d3f-8071-5f8685deef37', initialBalance: { amount: '10.00', currency: 'BRL' } };

describe('a wallet creation that fails transiently', () => {
  test('on a lock conflict: counted by its reason, and thrown', async () => {
    const conflicts: LockConflictReason[] = [];
    const error = new TransientFailureError(FailureCode.TransientLockTimeout, { lockConflict: 'deadlock' });

    await expect(createWallet(failingWith(error), conflicts).execute(command)).rejects.toBe(error);

    expect(conflicts).toEqual(['deadlock']);
  });

  test('with the database unavailable: not a lock conflict', async () => {
    const conflicts: LockConflictReason[] = [];
    const error = new TransientFailureError(FailureCode.TransientUnavailable);

    await expect(createWallet(failingWith(error), conflicts).execute(command)).rejects.toBe(error);

    expect(conflicts).toEqual([]);
  });
});

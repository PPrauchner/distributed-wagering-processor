/**
 * The opening of a wallet, as wagering records it: the internal `OPENING`
 * transaction, already `PROCESSED`, and its `WagerTransactionProcessed` in the
 * outbox — implements the `OpeningRecorder` port of `wallet`.
 *
 * @packageDocumentation
 */
import type { OutboxRepositories } from '../../messaging/application/outbox-repository.ts';
import { OutboxMessage } from '../../messaging/domain/outbox-message.ts';
import { hashPayload } from '../../shared/application/payload-hash.ts';
import type { OpeningRecorder, WalletOpening } from '../../wallet/application/opening-recorder.ts';
import { WagerTransaction, WagerTransactionKind } from '../domain/wager-transaction.ts';
import { WagerTransactionProcessed } from '../domain/wager-transaction-events.ts';
import type { WageringRepositories } from './wager-transaction-repository.ts';

/** The opening is internal: it never comes from a provider. */
const OPENING_PROVIDER_ID = 'internal';
const OPENING_ROUND_AND_GAME = 'opening';

export class RecordOpening implements OpeningRecorder<WageringRepositories & OutboxRepositories> {
  /** @param generateId - Generates the event's id. */
  constructor(private readonly generateId: () => string) {}

  record({ transactions, outbox }: WageringRepositories & OutboxRepositories, opening: WalletOpening): void {
    const transaction = this.openingOf(opening);
    transactions.add(transaction);
    const context = { correlationId: opening.correlationId, causationId: transaction.id };
    outbox.add(OutboxMessage.enqueue(WagerTransactionProcessed.from(transaction, context, { eventId: this.generateId() })));
  }

  /** The `OPENING` that credits the wallet's initial balance, already `PROCESSED`. */
  private openingOf({ transactionId, wallet, correlationId }: WalletOpening): WagerTransaction {
    const key = `opening:${wallet.id}`;
    const opening = WagerTransaction.create({
      id: transactionId,
      providerId: OPENING_PROVIDER_ID,
      externalTransactionId: key,
      idempotencyKey: key,
      payloadHash: hashPayload({
        walletId: wallet.id,
        playerId: wallet.playerId,
        initialBalance: { ...wallet.balance.toJSON() },
      }),
      walletId: wallet.id,
      playerId: wallet.playerId,
      roundId: OPENING_ROUND_AND_GAME,
      gameId: OPENING_ROUND_AND_GAME,
      kind: WagerTransactionKind.Opening,
      money: wallet.balance,
      correlationId,
    });
    opening.markProcessed({
      at: wallet.createdAt,
      balanceAfter: wallet.balance,
      walletVersionObserved: wallet.version,
    });
    return opening;
  }
}

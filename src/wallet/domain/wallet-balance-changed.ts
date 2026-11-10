/**
 * `WalletBalanceChanged`: the integration event of a balance that moved, with
 * the `data` of §11. Emitted only when the balance changes — that is, with a
 * ledger entry.
 *
 * @packageDocumentation
 */
import { IntegrationEvent, type EventContext } from '../../shared/domain/integration-event.ts';
import type { MoneyProps } from '../../shared/domain/money.ts';
import type { Wallet } from './wallet.ts';
import type { LedgerDirection, WalletLedgerEntry } from './wallet-ledger-entry.ts';

export interface WalletBalanceChangedData {
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  walletVersion: number;
}

export class WalletBalanceChanged extends IntegrationEvent<WalletBalanceChangedData> {
  readonly eventType = 'WalletBalanceChanged';
  readonly version = 1;

  /**
   * @param wallet - The wallet whose balance moved.
   * @param entry - The ledger entry that moved it.
   * @param context - Correlation and causation of the outcome.
   * @param ids - The new event's id.
   * @returns The event, aggregated by the wallet id, occurred when the entry was written.
   * @throws {@link Error} If the entry belongs to another wallet.
   */
  static from(
    wallet: Wallet,
    entry: WalletLedgerEntry,
    context: EventContext,
    ids: { eventId: string },
  ): WalletBalanceChanged {
    if (entry.walletId !== wallet.id) {
      throw new Error(`ledger entry ${entry.id} belongs to wallet ${entry.walletId}, not ${wallet.id}`);
    }
    return new WalletBalanceChanged({
      eventId: ids.eventId,
      aggregateId: wallet.id,
      ...context,
      occurredAt: entry.createdAt,
      data: {
        walletId: wallet.id,
        transactionId: entry.transactionId,
        direction: entry.direction,
        money: entry.money.toJSON(),
        balanceBefore: entry.balanceBefore.toJSON(),
        balanceAfter: entry.balanceAfter.toJSON(),
        walletVersion: entry.walletVersion,
      },
    });
  }
}

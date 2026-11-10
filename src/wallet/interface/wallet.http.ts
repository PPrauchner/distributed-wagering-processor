/**
 * HTTP contract of the wallet endpoints: request parsing and response shape.
 * Parsing checks the shape only; amount, currency and player id rules belong
 * to `Money` and `Wallet`.
 *
 * @packageDocumentation
 */
import type { MoneyProps } from '../../shared/domain/money.ts';
import { expectExactObject, expectString } from '../../shared/interface/invalid-payload.error.ts';
import type { CreateWalletCommand } from '../application/create-wallet.ts';
import type { Wallet } from '../domain/wallet.ts';

export interface WalletResponse {
  id: string;
  playerId: string;
  balance: MoneyProps;
  version: number;
}

/**
 * @param body - The untrusted request body.
 * @param correlationId - The `X-Correlation-Id` header; empty counts as absent,
 *   and the use case generates one.
 * @returns The create-wallet command.
 * @throws {@link InvalidPayloadError} If the body has a wrong shape, a wrong type
 *   or any unknown field, at any level.
 */
export function parseCreateWalletRequest(body: unknown, correlationId?: string): CreateWalletCommand {
  const request = expectExactObject(body, ['playerId', 'initialBalance'], 'body');
  const balance = expectExactObject(
    request.initialBalance,
    ['amount', 'currency'],
    'body.initialBalance',
  );
  return {
    playerId: expectString(request.playerId, 'body.playerId'),
    initialBalance: {
      amount: expectString(balance.amount, 'body.initialBalance.amount'),
      currency: expectString(balance.currency, 'body.initialBalance.currency'),
    },
    correlationId: correlationId || undefined,
  };
}

export function toWalletResponse(wallet: Wallet): WalletResponse {
  return {
    id: wallet.id,
    playerId: wallet.playerId,
    balance: wallet.balance.toJSON(),
    version: wallet.version,
  };
}

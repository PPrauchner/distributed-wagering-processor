/**
 * HTTP contract of the wallet endpoints: request parsing and response shape.
 * Parsing checks the shape only; amount, currency and player id rules belong
 * to `Money` and `Wallet`.
 *
 * @packageDocumentation
 */
import type { MoneyProps } from '../../shared/domain/money.ts';
import {
  expectExactObject,
  expectString,
  InvalidPayloadError,
} from '../../shared/interface/invalid-payload.error.ts';
import type { CreateWalletCommand } from '../application/create-wallet.ts';
import type { GetLedgerPageQuery, LedgerPage } from '../application/get-ledger-page.ts';
import type { ReconciliationReport } from '../application/reconciliation.ts';
import type { VersionGap } from '../application/wallet-repository.ts';
import type { Wallet } from '../domain/wallet.ts';
import type { LedgerDirection, WalletLedgerEntry } from '../domain/wallet-ledger-entry.ts';

export interface WalletResponse {
  id: string;
  playerId: string;
  balance: MoneyProps;
  version: number;
}

export interface LedgerEntryResponse {
  id: string;
  transactionId: string;
  direction: LedgerDirection;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  walletVersion: number;
  createdAt: string;
}

export interface LedgerPageResponse {
  items: LedgerEntryResponse[];
  nextCursor: string | null;
}

export interface ReconciliationResponse {
  walletId: string;
  storedBalance: MoneyProps;
  calculatedBalance: MoneyProps;
  difference: MoneyProps;
  consistent: boolean;
  checkedEntries: number;
  versionGaps: VersionGap[];
}

const DEFAULT_LEDGER_LIMIT = 50;
const MAX_LEDGER_LIMIT = 200;
const LIMIT_PATTERN = /^[1-9]\d{0,2}$/;

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

/**
 * @param walletId - The `:walletId` route parameter.
 * @param query - The untrusted query string: `cursor` and `limit`, both optional.
 * @returns The ledger page query; `limit` defaults to 50.
 * @throws {@link InvalidPayloadError} If `limit` is not an integer from 1 to 200,
 *   or a parameter is repeated.
 */
export function parseLedgerPageRequest(walletId: string, query: Record<string, unknown>): GetLedgerPageQuery {
  const { cursor, limit } = query;
  if (cursor !== undefined && typeof cursor !== 'string') throw new InvalidPayloadError('query.cursor must be a string');
  return { walletId, cursor, limit: parseLimit(limit) };
}

function parseLimit(limit: unknown): number {
  if (limit === undefined) return DEFAULT_LEDGER_LIMIT;
  const parsed = typeof limit === 'string' && LIMIT_PATTERN.test(limit) ? Number(limit) : NaN;
  if (!(parsed <= MAX_LEDGER_LIMIT)) {
    throw new InvalidPayloadError(`query.limit must be an integer from 1 to ${MAX_LEDGER_LIMIT}`);
  }
  return parsed;
}

export function toLedgerPageResponse(page: LedgerPage): LedgerPageResponse {
  return { items: page.items.map(toLedgerEntryResponse), nextCursor: page.nextCursor };
}

function toLedgerEntryResponse(entry: WalletLedgerEntry): LedgerEntryResponse {
  return {
    id: entry.id,
    transactionId: entry.transactionId,
    direction: entry.direction,
    money: entry.money.toJSON(),
    balanceBefore: entry.balanceBefore.toJSON(),
    balanceAfter: entry.balanceAfter.toJSON(),
    walletVersion: entry.walletVersion,
    createdAt: entry.createdAt.toISOString(),
  };
}

export function toReconciliationResponse(report: ReconciliationReport): ReconciliationResponse {
  return {
    walletId: report.walletId,
    storedBalance: report.storedBalance.toJSON(),
    calculatedBalance: report.calculatedBalance.toJSON(),
    difference: report.difference.toJSON(),
    consistent: report.consistent,
    checkedEntries: report.checkedEntries,
    versionGaps: report.versionGaps,
  };
}

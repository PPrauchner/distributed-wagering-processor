/**
 * The business payload of a wager transaction and its hash — the fingerprint
 * that tells a replay (same key, same hash) from a conflict (same key, another
 * hash), whatever the channel it came by (`ARCHITECTURE.md` § Hash do payload).
 *
 * @packageDocumentation
 */
import { hashPayload } from '../../shared/application/payload-hash.ts';
import type { Money } from '../../shared/domain/money.ts';
import type { WagerTransactionKind } from '../domain/wager-transaction.ts';

/** A submission's business fields, already validated. */
export interface WagerPayload {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string;
}

/**
 * Hashes exactly the business fields: `providerId`, `externalTransactionId`,
 * `playerId`, `walletId`, `roundId`, `gameId`, `kind`, `money` (`amount`,
 * `currency`) and `referenceExternalTransactionId`, omitted when absent. Any
 * other field of the argument — idempotency key, correlation id, channel or
 * transport metadata — is ignored, so the same submission hashes the same by
 * HTTP and by the queue.
 *
 * @param payload - The validated payload; extra fields are ignored.
 * @returns SHA-256 of its canonical JSON, 64 lowercase hex characters.
 */
export function hashWagerPayload(payload: WagerPayload): string {
  return hashPayload({
    providerId: payload.providerId,
    externalTransactionId: payload.externalTransactionId,
    playerId: payload.playerId,
    walletId: payload.walletId,
    roundId: payload.roundId,
    gameId: payload.gameId,
    kind: payload.kind,
    money: { ...payload.money.toJSON() },
    referenceExternalTransactionId: payload.referenceExternalTransactionId,
  });
}

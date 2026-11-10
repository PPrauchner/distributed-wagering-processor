/**
 * Processes a wager transaction submitted by a provider, whatever the channel:
 * validates it, deduplicates it by idempotency key and external id, locks its
 * wallet and records the outcome — transaction, balance and ledger entry — in
 * one unit of work, so in one SQL transaction. Checks run in the documented
 * order, and the first violation decides (`ARCHITECTURE.md` § Ordem das
 * validações). This slice settles `BET`.
 *
 * @packageDocumentation
 */
import type { UnitOfWork } from '../../shared/application/unit-of-work.ts';
import { Money, type MoneyProps } from '../../shared/domain/money.ts';
import type { WalletRepositories } from '../../wallet/application/wallet-repository.ts';
import { applyBet } from '../domain/bet.ts';
import {
  InvalidWagerTransactionError,
  WagerTransaction,
  WagerTransactionKind,
} from '../domain/wager-transaction.ts';
import { hashWagerPayload, type WagerPayload } from './wager-payload.ts';
import type { WagerTransactionRepository, WageringRepositories } from './wager-transaction-repository.ts';
import {
  ExternalIdConflictError,
  IdempotencyConflictError,
  InternalKindNotAllowedError,
  SubmissionWalletNotFoundError,
  UnsupportedKindError,
} from './wagering-errors.ts';

/** A submission as the channel received it: shaped, not yet validated. */
export interface SubmitWagerTransactionCommand {
  idempotencyKey: string;
  /** Recorded on the transaction; generated when absent. */
  correlationId?: string;
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
}

/** The transaction a submission ended in, and whether it was recorded before. */
export interface WagerTransactionOutcome {
  transaction: WagerTransaction;
  idempotentReplay: boolean;
}

const MAX_IDENTIFIER_LENGTH = 255;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KINDS = new Set<string>(Object.values(WagerTransactionKind));

export class ProcessWagerTransaction {
  constructor(
    private readonly unitOfWork: UnitOfWork<WalletRepositories & WageringRepositories>,
    private readonly generateId: () => string,
  ) {}

  /**
   * @param command - The submission, with its idempotency key already present.
   * @returns The transaction it ended in — `PROCESSED` or `REJECTED` — new or
   *   replayed.
   * @throws {@link InvalidMoneyError} If the money is malformed.
   * @throws {@link InvalidWagerTransactionError} If any other field breaks the
   *   payload contract or the rules of its kind.
   * @throws {@link InternalKindNotAllowedError} If it is a well-formed `OPENING`.
   * @throws {@link UnsupportedKindError} If its kind is not processed yet.
   * @throws {@link IdempotencyConflictError} If the provider used the key with
   *   another payload.
   * @throws {@link ExternalIdConflictError} If the provider used the external id
   *   with another key.
   * @throws {@link SubmissionWalletNotFoundError} If the wallet does not exist.
   */
  async execute(command: SubmitWagerTransactionCommand): Promise<WagerTransactionOutcome> {
    const submitted = this.validated(command);

    return this.unitOfWork.run(async ({ wallets, ledger, transactions }) => {
      const earlier = await findEarlier(transactions, submitted);
      if (earlier) return earlier;

      const wallet = await wallets.findByIdForUpdate(submitted.walletId);
      if (!wallet) throw new SubmissionWalletNotFoundError(submitted.walletId);
      // A concurrent submission may have committed while this one waited for the lock.
      const committedMeanwhile = await findEarlier(transactions, submitted);
      if (committedMeanwhile) return committedMeanwhile;

      const entry = applyBet(submitted, wallet, { entryId: this.generateId() });
      transactions.add(submitted);
      if (entry) ledger.add(entry);
      return { transaction: submitted, idempotentReplay: false };
    });
  }

  /** Steps 2 and 3 of the order: the payload's shape, then its hash. */
  private validated(command: SubmitWagerTransactionCommand): WagerTransaction {
    assertIdentifiers(command);
    const money = Money.from(command.money);
    if (!KINDS.has(command.kind)) {
      throw new InvalidWagerTransactionError(`kind must be one of ${[...KINDS].join(', ')}, got "${command.kind}"`);
    }
    const payload: WagerPayload = {
      providerId: command.providerId,
      externalTransactionId: command.externalTransactionId,
      playerId: command.playerId,
      walletId: command.walletId,
      roundId: command.roundId,
      gameId: command.gameId,
      kind: command.kind as WagerTransactionKind,
      money,
      referenceExternalTransactionId: command.referenceExternalTransactionId,
    };
    // `create` enforces the rules of the kind: amount floor and reference.
    const transaction = WagerTransaction.create({
      ...payload,
      id: this.generateId(),
      idempotencyKey: command.idempotencyKey,
      payloadHash: hashWagerPayload(payload),
      correlationId: command.correlationId ?? this.generateId(),
    });
    if (transaction.kind === WagerTransactionKind.Opening) throw new InternalKindNotAllowedError(transaction.kind);
    if (transaction.kind !== WagerTransactionKind.Bet) throw new UnsupportedKindError(transaction.kind);
    return transaction;
  }
}

/**
 * Steps 4 and 5 of the order: the provider's key, then its external id.
 *
 * @returns The replay of the transaction already recorded under the key, or
 *   `undefined` when neither is known.
 */
async function findEarlier(
  transactions: WagerTransactionRepository,
  submitted: WagerTransaction,
): Promise<WagerTransactionOutcome | undefined> {
  const earlier =
    (await transactions.findByIdempotencyKey(submitted.providerId, submitted.idempotencyKey)) ??
    (await transactions.findByExternalId(submitted.providerId, submitted.externalTransactionId));
  if (!earlier) return undefined;
  // The two reads are separate statements: a concurrent submission of the same
  // key may commit between them, and then shows up by its external id. Under
  // the same key it is this submission, not an external id conflict.
  if (earlier.idempotencyKey !== submitted.idempotencyKey) {
    throw new ExternalIdConflictError(submitted.providerId, submitted.externalTransactionId);
  }
  if (earlier.payloadHash !== submitted.payloadHash) {
    throw new IdempotencyConflictError(submitted.providerId, submitted.idempotencyKey);
  }
  return { transaction: earlier, idempotentReplay: true };
}

function assertIdentifiers(command: SubmitWagerTransactionCommand): void {
  const identifiers: [string, string | undefined][] = [
    ['Idempotency-Key', command.idempotencyKey],
    ['providerId', command.providerId],
    ['externalTransactionId', command.externalTransactionId],
    ['playerId', command.playerId],
    ['roundId', command.roundId],
    ['gameId', command.gameId],
    ['referenceExternalTransactionId', command.referenceExternalTransactionId],
  ];
  for (const [name, value] of identifiers) {
    if (value !== undefined && (value.length === 0 || value.length > MAX_IDENTIFIER_LENGTH)) {
      throw new InvalidWagerTransactionError(`${name} must have between 1 and ${MAX_IDENTIFIER_LENGTH} characters`);
    }
  }
  if (!UUID_PATTERN.test(command.walletId)) {
    throw new InvalidWagerTransactionError(`walletId must be a UUID, got "${command.walletId}"`);
  }
}

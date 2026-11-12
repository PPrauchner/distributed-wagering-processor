/**
 * `WalletMetrics` port: what the wallet use cases count — the lock conflicts
 * of a wallet creation —, without depending on a metrics library
 * (`ARCHITECTURE.md` § Observabilidade).
 *
 * @packageDocumentation
 */
import type { LockConflictReason } from '../../shared/application/infrastructure-failures.ts';

/** Injection token of the wallet metrics implementation. */
export const WALLET_METRICS = Symbol('WalletMetrics');

export interface WalletMetrics {
  lockConflict(reason: LockConflictReason): void;
}

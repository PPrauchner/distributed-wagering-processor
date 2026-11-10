/**
 * `UnitOfWork` port: how a use case opens one SQL transaction and gets the
 * repositories bound to it, without depending on the ORM (ADR 0001).
 *
 * @packageDocumentation
 */

export interface UnitOfWork<TRepositories> {
  /**
   * Runs `work` inside a single SQL transaction, committed when it resolves and
   * rolled back when it throws.
   *
   * @param work - The unit of work, given repositories bound to the transaction.
   * @returns What `work` returns, once committed.
   */
  run<T>(work: (repositories: TRepositories) => Promise<T>): Promise<T>;
}

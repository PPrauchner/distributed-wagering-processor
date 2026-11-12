/**
 * `RejectedSubmissionRepository` over a MikroORM entity manager bound to one
 * transaction. Records are only ever added: the table is append-only.
 *
 * @packageDocumentation
 */
import type { EntityManager } from '@mikro-orm/postgresql';
import type { RejectedSubmissionRepository } from '../application/rejected-submission-repository.ts';
import type { RejectedSubmission } from '../domain/rejected-submission.ts';

export class MikroOrmRejectedSubmissionRepository implements RejectedSubmissionRepository {
  constructor(private readonly em: EntityManager) {}

  add(submission: RejectedSubmission): void {
    this.em.persist(submission);
  }
}

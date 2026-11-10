/**
 * `RejectedSubmissionRepository` port: where the audit of the submissions not
 * admitted is recorded.
 *
 * @packageDocumentation
 */
import type { RejectedSubmission } from '../domain/rejected-submission.ts';

export interface RejectedSubmissionRepository {
  /** Registers a new record; it is written when the unit of work commits. */
  add(submission: RejectedSubmission): void;
}

export interface RejectedSubmissionRepositories {
  rejectedSubmissions: RejectedSubmissionRepository;
}

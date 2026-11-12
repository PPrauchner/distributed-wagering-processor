/**
 * Records a submission not admitted — refused before or without becoming a
 * wager transaction — in a unit of work of its own, at the point of the
 * refusal (`ARCHITECTURE.md` § Submissões não admitidas). Every attempt is a
 * record; replays are not refusals and never come here.
 *
 * @packageDocumentation
 */
import type { UnitOfWork } from '../../shared/application/unit-of-work.ts';
import { RejectedSubmission, type RejectedSubmissionProps } from '../domain/rejected-submission.ts';
import type { RejectedSubmissionRepositories } from './rejected-submission-repository.ts';
import type { WageringMetrics } from './wagering-metrics.ts';

/** What the channel could extract from the refused submission. */
export type RecordRejectedSubmissionCommand = Omit<RejectedSubmissionProps, 'id' | 'receivedAt'>;

export class RecordRejectedSubmission {
  constructor(
    private readonly unitOfWork: UnitOfWork<RejectedSubmissionRepositories>,
    private readonly generateId: () => string,
    private readonly metrics: Pick<WageringMetrics, 'submissionNotAdmitted'>,
  ) {}

  /**
   * @param command - The refusal's failure code and channel, and whatever
   *   identifiers the submission carried.
   */
  async execute(command: RecordRejectedSubmissionCommand): Promise<void> {
    const submission = RejectedSubmission.record({ ...command, id: this.generateId(), receivedAt: new Date() });
    // Counted even if recording it fails: the refusal happened.
    this.metrics.submissionNotAdmitted(command.failureCode, command.channel);
    await this.unitOfWork.run(async ({ rejectedSubmissions }) => {
      rejectedSubmissions.add(submission);
    });
  }
}

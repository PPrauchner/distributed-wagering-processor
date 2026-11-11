/**
 * `RejectedSubmission`: the audit record of a submission that never became a
 * wager transaction — a submissão não admitida (`CONTEXT.md`). It has no
 * outcome and no `transactionId`; it keeps what could be extracted from the
 * submission, since a refused payload may lack even its key. Immutable.
 *
 * @packageDocumentation
 */
import type { FailureCode } from '../../shared/domain/failure-code.ts';

/** How a submission arrived. */
export enum SubmissionChannel {
  Http = 'HTTP',
  Queue = 'QUEUE',
}

export interface RejectedSubmissionProps {
  id: string;
  providerId?: string;
  idempotencyKey?: string;
  externalTransactionId?: string;
  payloadHash?: string;
  failureCode: FailureCode;
  channel: SubmissionChannel;
  /** The queue envelope's `messageId`, when it came by the queue. */
  messageId?: string;
  correlationId?: string;
  receivedAt: Date;
}

export class RejectedSubmission {
  // Only assigns parameters: the ORM's metadata discovery calls the constructor
  // with no arguments (ADR 0001).
  private constructor(
    readonly id: string,
    readonly providerId: string | undefined,
    readonly idempotencyKey: string | undefined,
    readonly externalTransactionId: string | undefined,
    readonly payloadHash: string | undefined,
    readonly failureCode: FailureCode,
    readonly channel: SubmissionChannel,
    readonly messageId: string | undefined,
    readonly correlationId: string | undefined,
    readonly receivedAt: Date,
  ) {}

  /**
   * @param props - What could be extracted from the refused submission.
   * @returns The audit record.
   */
  static record(props: RejectedSubmissionProps): RejectedSubmission {
    return new RejectedSubmission(
      props.id,
      props.providerId,
      props.idempotencyKey,
      props.externalTransactionId,
      props.payloadHash,
      props.failureCode,
      props.channel,
      props.messageId,
      props.correlationId,
      props.receivedAt,
    );
  }
}

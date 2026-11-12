/**
 * `RejectedSubmission` mapping, kept out of the domain.
 *
 * @packageDocumentation
 */
import { defineEntity, p, type EntityCtor } from '@mikro-orm/core';
import { RejectedSubmission, SubmissionChannel } from '../domain/rejected-submission.ts';

// Type-only cast for the private constructor; see `money.schema.ts`.
const RejectedSubmissionClass = RejectedSubmission as unknown as EntityCtor<RejectedSubmission>;

export const RejectedSubmissionSchema = defineEntity({
  class: RejectedSubmissionClass,
  tableName: 'rejected_submissions',
  properties: {
    id: p.uuid().primary(),
    providerId: p.text().nullable(),
    idempotencyKey: p.text().nullable(),
    externalTransactionId: p.text().nullable(),
    payloadHash: p.text().nullable(),
    failureCode: p.text(),
    channel: p.enum(() => SubmissionChannel),
    messageId: p.text().nullable(),
    correlationId: p.text().nullable(),
    receivedAt: p.datetime(),
  },
});

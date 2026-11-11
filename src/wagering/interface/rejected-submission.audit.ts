/**
 * Audit of the submissions `POST /wagering/transactions` does not admit: for
 * each refusal of that endpoint, records what could be extracted — identifiers
 * from the body, if it is an object, the headers and, when the payload got that
 * far, its hash (`ARCHITECTURE.md` § Submissões não admitidas). The response
 * is not changed. Replays are not refusals and never get here.
 *
 * @packageDocumentation
 */
import { FailureCode } from '../../shared/domain/failure-code.ts';
import type { RecordRejectedSubmission } from '../application/record-rejected-submission.ts';
import { SubmissionChannel } from '../domain/rejected-submission.ts';
import { WAGER_TRANSACTIONS_PATH } from './wager-transaction.controller.ts';

/** The refused request, as the HTTP layer hands it over. */
export interface RefusedSubmissionRequest {
  method: string;
  path: string;
  body: unknown;
  headers: Record<string, string | string[] | undefined>;
}

const NOT_ADMITTED = new Set<string>([
  FailureCode.InvalidPayload,
  FailureCode.MissingIdempotencyKey,
  FailureCode.InternalKindNotAllowed,
  FailureCode.WalletNotFound,
  FailureCode.IdempotencyConflict,
  FailureCode.ExternalIdConflict,
  FailureCode.ProviderIdentityMismatch,
]);

export class RejectedSubmissionAudit {
  constructor(private readonly recordRejectedSubmission: RecordRejectedSubmission) {}

  /**
   * Records the refusal when it answered a submission and is a submission not
   * admitted; ignores anything else.
   *
   * @param request - The refused request.
   * @param failureCode - The failure code of the refusal's response.
   * @param error - What was refused; carries the payload hash when it was computed.
   */
  async refused(request: RefusedSubmissionRequest, failureCode: string, error: unknown): Promise<void> {
    if (!isSubmission(request) || !NOT_ADMITTED.has(failureCode)) return;
    const body = isRecord(request.body) ? request.body : {};
    await this.recordRejectedSubmission.execute({
      providerId: nonEmptyString(body.providerId),
      externalTransactionId: nonEmptyString(body.externalTransactionId),
      idempotencyKey: header(request, 'idempotency-key'),
      correlationId: header(request, 'x-correlation-id'),
      payloadHash: isRecord(error) ? nonEmptyString(error.payloadHash) : undefined,
      failureCode: failureCode as FailureCode,
      channel: SubmissionChannel.Http,
    });
  }
}

function isSubmission(request: RefusedSubmissionRequest): boolean {
  return request.method === 'POST' && request.path.replace(/^\/+|\/+$/g, '') === WAGER_TRANSACTIONS_PATH;
}

function header(request: RefusedSubmissionRequest, name: string): string | undefined {
  return nonEmptyString(request.headers[name]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

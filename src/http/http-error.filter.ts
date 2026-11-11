/**
 * Global HTTP error filter: turns every error into `{ failureCode, message }`
 * with the status of the HTTP status table in `ARCHITECTURE.md`. Before
 * answering, it reports the refusal to the audits — the only point every
 * refusal goes through, malformed JSON included, which never reaches a
 * controller.
 *
 * @packageDocumentation
 */
import {
  Catch,
  HttpException,
  HttpStatus,
  Logger,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import { PermanentFailureError, TransientFailureError } from '../shared/application/infrastructure-failures.ts';
import { ProviderIdentityMismatchError } from '../shared/application/provider-identity.ts';
import { FailureCode } from '../shared/domain/failure-code.ts';
import { CurrencyMismatchError, InvalidMoneyError } from '../shared/domain/money.ts';
import { InvalidPayloadError } from '../shared/interface/invalid-payload.error.ts';
import { WagerTransactionNotFoundError } from '../wagering/application/get-wager-transaction.ts';
import {
  ExternalIdConflictError,
  IdempotencyConflictError,
  InternalKindNotAllowedError,
  MissingIdempotencyKeyError,
  SubmissionWalletNotFoundError,
} from '../wagering/application/wagering-errors.ts';
import { InvalidWagerTransactionError } from '../wagering/domain/wager-transaction.ts';
import { InvalidWalletError } from '../wallet/domain/wallet.ts';
import {
  EmptyCreationKeyError,
  InvalidCursorError,
  WalletAlreadyExistsError,
  WalletCreationConflictError,
  WalletNotFoundError,
} from '../wallet/application/wallet-errors.ts';

// The slice of the platform response this filter uses; keeps it off Express types.
interface HttpResponse {
  setHeader(name: string, value: string): void;
  status(code: number): { json(body: unknown): void };
}

interface ErrorResponse {
  status: number;
  body: { failureCode: string; message: string; walletId?: string };
  headers?: Record<string, string>;
}

/** The request a refusal answered, as the audits see it. */
export interface RefusedRequest {
  method: string;
  path: string;
  body: unknown;
  headers: Record<string, string | string[] | undefined>;
}

/** Records the refusals it cares about; the filter answers once it is done. */
export interface RefusalAudit {
  refused(request: RefusedRequest, failureCode: string, error: unknown): Promise<void>;
}

export interface HttpErrorFilterOptions {
  /** The `Retry-After` of a transient failure's 503, in seconds. */
  retryAfterSeconds: number;
  refusalAudits?: readonly RefusalAudit[];
}

const INVALID_PAYLOAD_ERRORS = [
  InvalidPayloadError,
  InvalidMoneyError,
  CurrencyMismatchError,
  InvalidWalletError,
  InvalidWagerTransactionError,
];

// Refused requests: a fixed status and failure code, and the error's message.
const REFUSED_SUBMISSIONS: [new (...args: never[]) => Error, number, FailureCode][] = [
  [MissingIdempotencyKeyError, HttpStatus.BAD_REQUEST, FailureCode.MissingIdempotencyKey],
  [EmptyCreationKeyError, HttpStatus.BAD_REQUEST, FailureCode.MissingIdempotencyKey],
  [InternalKindNotAllowedError, HttpStatus.BAD_REQUEST, FailureCode.InternalKindNotAllowed],
  [IdempotencyConflictError, HttpStatus.CONFLICT, FailureCode.IdempotencyConflict],
  [WalletCreationConflictError, HttpStatus.CONFLICT, FailureCode.IdempotencyConflict],
  [ExternalIdConflictError, HttpStatus.CONFLICT, FailureCode.ExternalIdConflict],
  [SubmissionWalletNotFoundError, HttpStatus.UNPROCESSABLE_ENTITY, FailureCode.WalletNotFound],
  [InvalidCursorError, HttpStatus.BAD_REQUEST, FailureCode.InvalidCursor],
  [ProviderIdentityMismatchError, HttpStatus.FORBIDDEN, FailureCode.ProviderIdentityMismatch],
];

@Catch()
export class HttpErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpErrorFilter.name);

  constructor(private readonly options: HttpErrorFilterOptions) {}

  catch(error: unknown, host: ArgumentsHost): Promise<void> {
    return this.answer(error, host);
  }

  private async answer(error: unknown, host: ArgumentsHost): Promise<void> {
    const { status, body, headers = {} } = this.toResponse(error);
    const http = host.switchToHttp();
    if (status < HttpStatus.INTERNAL_SERVER_ERROR) await this.audit(http.getRequest<RefusedRequest>(), body.failureCode, error);
    const response = http.getResponse<HttpResponse>();
    for (const [name, value] of Object.entries(headers)) response.setHeader(name, value);
    response.status(status).json(body);
  }

  // The audit is best effort: a failure to record it never changes the answer.
  private async audit(request: RefusedRequest, failureCode: string, error: unknown): Promise<void> {
    for (const audit of this.options.refusalAudits ?? []) {
      try {
        await audit.refused(request, failureCode, error);
      } catch (auditError) {
        this.logger.error(auditError);
      }
    }
  }

  private toResponse(error: unknown): ErrorResponse {
    if (error instanceof TransientFailureError) {
      this.logger.warn(`${error.failureCode}: ${String(error.cause)}`);
      return {
        status: HttpStatus.SERVICE_UNAVAILABLE,
        body: { failureCode: error.failureCode, message: error.message },
        headers: { 'Retry-After': String(this.options.retryAfterSeconds) },
      };
    }
    if (error instanceof PermanentFailureError) {
      this.logger.error(error);
      return {
        status: HttpStatus.INTERNAL_SERVER_ERROR,
        body: { failureCode: error.failureCode, message: error.message },
      };
    }
    if (INVALID_PAYLOAD_ERRORS.some((type) => error instanceof type)) {
      return invalidPayload((error as Error).message);
    }
    const refused = REFUSED_SUBMISSIONS.find(([type]) => error instanceof type);
    if (refused) {
      const [, status, failureCode] = refused;
      return { status, body: { failureCode, message: (error as Error).message } };
    }
    if (error instanceof WalletAlreadyExistsError) {
      return {
        status: HttpStatus.CONFLICT,
        body: { failureCode: 'WALLET_ALREADY_EXISTS', message: error.message, walletId: error.walletId },
      };
    }
    if (error instanceof WalletNotFoundError || error instanceof WagerTransactionNotFoundError) {
      return notFound(error.message);
    }
    if (error instanceof HttpException) {
      // Framework errors: malformed JSON (400), unknown routes (404), and any
      // other client error (e.g. 413 body too large) keeps its own 4xx status.
      const status = error.getStatus();
      if (status === HttpStatus.NOT_FOUND) return notFound(error.message);
      if (isClientError(status)) return invalidPayload(error.message, status);
    }
    this.logger.error(error);
    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      body: { failureCode: FailureCode.InfraUnexpected, message: 'internal error' },
    };
  }
}

function invalidPayload(message: string, status: number = HttpStatus.BAD_REQUEST): ErrorResponse {
  return { status, body: { failureCode: 'INVALID_PAYLOAD', message } };
}

function isClientError(status: number): boolean {
  return status >= 400 && status < 500;
}

function notFound(message: string): ErrorResponse {
  return { status: HttpStatus.NOT_FOUND, body: { failureCode: 'NOT_FOUND', message } };
}

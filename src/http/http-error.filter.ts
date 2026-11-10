/**
 * Global HTTP error filter: turns every error into `{ failureCode, message }`
 * with the status of the HTTP status table in `ARCHITECTURE.md`.
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
import { CurrencyMismatchError, InvalidMoneyError } from '../shared/domain/money.ts';
import { InvalidPayloadError } from '../shared/interface/invalid-payload.error.ts';
import { InvalidWalletError } from '../wallet/domain/wallet.ts';
import {
  UnsupportedInitialBalanceError,
  WalletAlreadyExistsError,
  WalletNotFoundError,
} from '../wallet/application/wallet-errors.ts';

// The slice of the platform response this filter uses; keeps it off Express types.
interface HttpResponse {
  status(code: number): { json(body: unknown): void };
}

interface ErrorResponse {
  status: number;
  body: { failureCode: string; message: string; walletId?: string };
}

const INVALID_PAYLOAD_ERRORS = [
  InvalidPayloadError,
  InvalidMoneyError,
  CurrencyMismatchError,
  InvalidWalletError,
  UnsupportedInitialBalanceError,
];

@Catch()
export class HttpErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpErrorFilter.name);

  catch(error: unknown, host: ArgumentsHost): void {
    const { status, body } = this.toResponse(error);
    host.switchToHttp().getResponse<HttpResponse>().status(status).json(body);
  }

  private toResponse(error: unknown): ErrorResponse {
    if (INVALID_PAYLOAD_ERRORS.some((type) => error instanceof type)) {
      return invalidPayload((error as Error).message);
    }
    if (error instanceof WalletAlreadyExistsError) {
      return {
        status: HttpStatus.CONFLICT,
        body: { failureCode: 'WALLET_ALREADY_EXISTS', message: error.message, walletId: error.walletId },
      };
    }
    if (error instanceof WalletNotFoundError) return notFound(error.message);
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
      body: { failureCode: 'INTERNAL_ERROR', message: 'internal error' },
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

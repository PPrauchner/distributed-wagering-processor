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
      // Framework errors: malformed JSON (400) and unknown routes (404).
      if (error.getStatus() === HttpStatus.BAD_REQUEST) return invalidPayload(error.message);
      if (error.getStatus() === HttpStatus.NOT_FOUND) return notFound(error.message);
    }
    this.logger.error(error);
    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      body: { failureCode: 'INTERNAL_ERROR', message: 'internal error' },
    };
  }
}

function invalidPayload(message: string): ErrorResponse {
  return { status: HttpStatus.BAD_REQUEST, body: { failureCode: 'INVALID_PAYLOAD', message } };
}

function notFound(message: string): ErrorResponse {
  return { status: HttpStatus.NOT_FOUND, body: { failureCode: 'NOT_FOUND', message } };
}

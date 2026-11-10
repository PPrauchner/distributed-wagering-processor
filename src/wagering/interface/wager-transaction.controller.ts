/**
 * `POST /wagering/transactions`: submits a wager transaction and answers with
 * its outcome. Refused submissions are turned into responses by the global
 * HTTP error filter.
 *
 * @packageDocumentation
 */
import { Body, Controller, Headers, Post, Res } from '@nestjs/common';
import { ProcessWagerTransaction } from '../application/process-wager-transaction.ts';
import {
  parseSubmitWagerTransactionRequest,
  toWagerTransactionResponse,
  type WagerTransactionResponse,
} from './wager-transaction.http.ts';

// The slice of the platform response this controller uses; keeps it off Express types.
interface HttpResponse {
  status(code: number): unknown;
}

@Controller('wagering/transactions')
export class WagerTransactionController {
  constructor(private readonly processWagerTransaction: ProcessWagerTransaction) {}

  @Post()
  async submit(
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Headers('x-correlation-id') correlationId: string | undefined,
    @Res({ passthrough: true }) response: HttpResponse,
  ): Promise<WagerTransactionResponse> {
    const command = parseSubmitWagerTransactionRequest(body, { idempotencyKey, correlationId });
    const outcome = toWagerTransactionResponse(await this.processWagerTransaction.execute(command));
    response.status(outcome.statusCode);
    return outcome.body;
  }
}

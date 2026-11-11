/**
 * Wager transaction endpoints: `POST /wagering/transactions` submits one and
 * answers with its outcome; `GET /wagering/transactions/:transactionId` and
 * `GET /providers/:providerId/wagering/transactions/:externalTransactionId`
 * query one by its internal id or by the id its provider gave it. Refused
 * submissions and unknown transactions are turned into responses by the
 * global HTTP error filter.
 *
 * @packageDocumentation
 */
import { Body, Controller, Get, Headers, Param, Post, Res } from '@nestjs/common';
import { GetWagerTransaction } from '../application/get-wager-transaction.ts';
import { ProcessWagerTransaction } from '../application/process-wager-transaction.ts';
import { SubmissionChannel } from '../domain/rejected-submission.ts';
import {
  parseSubmitWagerTransactionRequest,
  toWagerTransactionResponse,
  toWagerTransactionView,
  type WagerTransactionResponse,
  type WagerTransactionView,
} from './wager-transaction.http.ts';

// The slice of the platform response this controller uses; keeps it off Express types.
interface HttpResponse {
  status(code: number): unknown;
}

/** The route of the submission endpoint. */
export const WAGER_TRANSACTIONS_PATH = 'wagering/transactions';

@Controller(WAGER_TRANSACTIONS_PATH)
export class WagerTransactionController {
  constructor(
    private readonly processWagerTransaction: ProcessWagerTransaction,
    private readonly getWagerTransaction: GetWagerTransaction,
  ) {}

  @Get(':transactionId')
  async show(@Param('transactionId') transactionId: string): Promise<WagerTransactionView> {
    return toWagerTransactionView(await this.getWagerTransaction.byId(transactionId));
  }

  @Post()
  async submit(
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Headers('x-correlation-id') correlationId: string | undefined,
    @Res({ passthrough: true }) response: HttpResponse,
  ): Promise<WagerTransactionResponse> {
    const command = parseSubmitWagerTransactionRequest(body, { idempotencyKey, correlationId });
    const settled = await this.processWagerTransaction.execute(command, SubmissionChannel.Http);
    const outcome = toWagerTransactionResponse(settled);
    response.status(outcome.statusCode);
    return outcome.body;
  }
}

@Controller('providers/:providerId/wagering/transactions')
export class ProviderWagerTransactionController {
  constructor(private readonly getWagerTransaction: GetWagerTransaction) {}

  @Get(':externalTransactionId')
  async show(
    @Param('providerId') providerId: string,
    @Param('externalTransactionId') externalTransactionId: string,
  ): Promise<WagerTransactionView> {
    return toWagerTransactionView(await this.getWagerTransaction.byExternalId(providerId, externalTransactionId));
  }
}

/**
 * Wallet endpoints: `POST /wallets`, `GET /wallets/:id` and
 * `GET /wallets/:walletId/ledger` and `POST /wallets/:walletId/reconciliation`. Every route
 * goes through the provider identity guard, which only resolves the identity:
 * the routes declare no provider, so there is nothing to check it against.
 * Errors are turned into responses by the global HTTP error filter.
 *
 * @packageDocumentation
 */
import { Body, Controller, Get, Headers, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ProviderIdentityGuard } from '../../shared/interface/provider-identity.guard.ts';
import { CreateWallet } from '../application/create-wallet.ts';
import { GetLedgerPage } from '../application/get-ledger-page.ts';
import { GetWallet } from '../application/get-wallet.ts';
import { Reconciliation } from '../application/reconciliation.ts';
import {
  parseCreateWalletRequest,
  parseLedgerPageRequest,
  toLedgerPageResponse,
  toReconciliationResponse,
  toCreatedWalletResponse,
  toWalletResponse,
  type CreatedWalletResponse,
  type LedgerPageResponse,
  type ReconciliationResponse,
  type WalletResponse,
} from './wallet.http.ts';

@Controller('wallets')
@UseGuards(ProviderIdentityGuard)
export class WalletController {
  constructor(
    private readonly createWallet: CreateWallet,
    private readonly getWallet: GetWallet,
    private readonly getLedgerPage: GetLedgerPage,
    private readonly reconciliation: Reconciliation,
  ) {}

  @Post()
  @HttpCode(201)
  async create(
    @Body() body: unknown,
    @Headers('x-correlation-id') correlationId: string | undefined,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
  ): Promise<CreatedWalletResponse> {
    const command = parseCreateWalletRequest(body, { correlationId, idempotencyKey });
    return toCreatedWalletResponse(await this.createWallet.execute(command), command.idempotencyKey !== undefined);
  }

  @Get(':id')
  async show(@Param('id') id: string): Promise<WalletResponse> {
    return toWalletResponse(await this.getWallet.execute(id));
  }

  @Get(':walletId/ledger')
  async ledger(
    @Param('walletId') walletId: string,
    @Query() query: Record<string, unknown>,
  ): Promise<LedgerPageResponse> {
    return toLedgerPageResponse(await this.getLedgerPage.execute(parseLedgerPageRequest(walletId, query)));
  }

  // 200 even on a divergence: the finding is the report.
  @Post(':walletId/reconciliation')
  @HttpCode(200)
  async reconcile(@Param('walletId') walletId: string): Promise<ReconciliationResponse> {
    return toReconciliationResponse(await this.reconciliation.execute(walletId));
  }
}

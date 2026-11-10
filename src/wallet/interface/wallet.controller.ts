/**
 * Wallet endpoints: `POST /wallets` and `GET /wallets/:id`. Errors are turned
 * into responses by the global HTTP error filter.
 *
 * @packageDocumentation
 */
import { Body, Controller, Get, Headers, HttpCode, Param, Post } from '@nestjs/common';
import { CreateWallet } from '../application/create-wallet.ts';
import { GetWallet } from '../application/get-wallet.ts';
import { parseCreateWalletRequest, toWalletResponse, type WalletResponse } from './wallet.http.ts';

@Controller('wallets')
export class WalletController {
  constructor(
    private readonly createWallet: CreateWallet,
    private readonly getWallet: GetWallet,
  ) {}

  @Post()
  @HttpCode(201)
  async create(
    @Body() body: unknown,
    @Headers('x-correlation-id') correlationId: string | undefined,
  ): Promise<WalletResponse> {
    const wallet = await this.createWallet.execute(parseCreateWalletRequest(body, correlationId));
    return toWalletResponse(wallet);
  }

  @Get(':id')
  async show(@Param('id') id: string): Promise<WalletResponse> {
    return toWalletResponse(await this.getWallet.execute(id));
  }
}

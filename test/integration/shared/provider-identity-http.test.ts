/**
 * The provider identity extension point end to end: the app runs in process
 * against the real PostgreSQL with a fake `ProviderIdentity` — swapped in by
 * overriding the Nest provider — that authenticates every request as another
 * provider. A submission or a query by external id declaring a provider other
 * than the authenticated one answers 403 `PROVIDER_IDENTITY_MISMATCH` and
 * records no wager transaction; the wallet routes go through the guard, the
 * health and metrics routes do not.
 *
 * @packageDocumentation
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { SQL } from 'bun';
import type { INestApplication } from '@nestjs/common';
import { createApp } from '../../../src/app.ts';
import { loadConfig } from '../../../src/config.ts';
import type {
  AuthenticatedProvider,
  ProviderIdentity,
  ProviderIdentityRequest,
} from '../../../src/shared/application/provider-identity.ts';

/** Authenticates every request as `provider-b`, and counts the requests it saw. */
class OtherProviderIdentity implements ProviderIdentity {
  readonly seen: string[] = [];

  async authenticate(request: ProviderIdentityRequest): Promise<AuthenticatedProvider> {
    this.seen.push(request.path);
    return { providerId: 'provider-b' };
  }
}

const identity = new OtherProviderIdentity();
let app: INestApplication;
let baseUrl: string;
let sql: SQL;

beforeAll(async () => {
  const config = loadConfig();
  sql = new SQL(config.databaseUrl);
  app = await createApp(config, { providerIdentity: identity });
  await app.listen(0, '127.0.0.1');
  baseUrl = await app.getUrl();
});

afterAll(async () => {
  await app?.close();
  await sql?.close();
});

type JsonObject = Record<string, unknown>;

async function createWallet(): Promise<{ id: string; playerId: string }> {
  const playerId = Bun.randomUUIDv7();
  const response = await fetch(`${baseUrl}/wallets`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ playerId, initialBalance: { amount: '100.00', currency: 'BRL' } }),
  });
  expect(response.status).toBe(201);
  const { id } = (await response.json()) as { id: string };
  return { id, playerId };
}

async function submit(body: unknown, idempotencyKey = `key-${Bun.randomUUIDv7()}`) {
  const response = await fetch(`${baseUrl}/wagering/transactions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': idempotencyKey },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as JsonObject };
}

describe('a provider identity other than the declared provider', () => {
  test('a submission is refused 403 PROVIDER_IDENTITY_MISMATCH, with no wager transaction', async () => {
    const wallet = await createWallet();
    const externalTransactionId = Bun.randomUUIDv7();

    const { status, body } = await submit({
      providerId: 'provider-a',
      externalTransactionId,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: 'round-1',
      gameId: 'fortune-chimp',
      kind: 'BET',
      money: { amount: '10.00', currency: 'BRL' },
    });

    expect(status).toBe(403);
    expect(body.failureCode).toBe('PROVIDER_IDENTITY_MISMATCH');
    const transactions = await sql`
      select 1 from wager_transactions where external_transaction_id = ${externalTransactionId}
    `;
    expect(transactions).toHaveLength(0);
    const refusals = await sql`
      select failure_code from rejected_submissions where external_transaction_id = ${externalTransactionId}
    `;
    expect(refusals).toEqual([{ failure_code: 'PROVIDER_IDENTITY_MISMATCH' }]);
  });

  test('an invalid payload is still refused 400 INVALID_PAYLOAD first', async () => {
    const { status, body } = await submit({ providerId: 'provider-a' });

    expect(status).toBe(400);
    expect(body.failureCode).toBe('INVALID_PAYLOAD');
  });

  test('a query by external id is refused 403 PROVIDER_IDENTITY_MISMATCH', async () => {
    const response = await fetch(`${baseUrl}/providers/provider-a/wagering/transactions/${Bun.randomUUIDv7()}`);

    expect(response.status).toBe(403);
    expect(((await response.json()) as JsonObject).failureCode).toBe('PROVIDER_IDENTITY_MISMATCH');
  });

  test('a query by external id of the authenticated provider is not refused', async () => {
    const response = await fetch(`${baseUrl}/providers/provider-b/wagering/transactions/${Bun.randomUUIDv7()}`);

    expect(response.status).toBe(404);
  });
});

describe('the guard', () => {
  test('resolves the identity on the wallet and wagering routes, not on health or metrics', async () => {
    identity.seen.length = 0;
    await fetch(`${baseUrl}/health/live`);
    await fetch(`${baseUrl}/metrics`);
    expect(identity.seen).toEqual([]);

    await fetch(`${baseUrl}/wallets/${Bun.randomUUIDv7()}`);
    await fetch(`${baseUrl}/wagering/transactions/${Bun.randomUUIDv7()}`);
    expect(identity.seen).toHaveLength(2);
  });
});

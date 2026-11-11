/**
 * `/health/live` and `/health/ready` end to end, against the real PostgreSQL
 * and the real LocalStack: readiness answers 200 only with both up, and 503
 * when either is unreachable; liveness answers 200 regardless.
 *
 * @packageDocumentation
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { INestApplication } from '@nestjs/common';
import { createApp } from '../../../src/app.ts';
import { loadConfig, type AppConfig } from '../../../src/config.ts';

const apps: INestApplication[] = [];
let config: AppConfig;

async function startApp(appConfig: AppConfig): Promise<string> {
  const app = await createApp(appConfig);
  await app.listen(0, '127.0.0.1');
  apps.push(app);
  return app.getUrl();
}

beforeAll(() => {
  config = loadConfig();
});

afterAll(async () => {
  await Promise.all(apps.map((app) => app.close()));
});

function databaseDown(base: AppConfig): AppConfig {
  const unreachable = new URL(base.databaseUrl);
  unreachable.port = '1';
  return { ...base, databaseUrl: unreachable.toString() };
}

function queueDown(base: AppConfig): AppConfig {
  return { ...base, sqs: { ...base.sqs, endpoint: 'http://127.0.0.1:1' } };
}

describe('readiness', () => {
  test('PostgreSQL and SQS up → 200', async () => {
    const url = await startApp(config);

    const response = await fetch(`${url}/health/ready`);

    expect(response.status).toBe(200);
  });

  test('PostgreSQL unreachable → 503', async () => {
    const url = await startApp(databaseDown(config));

    const response = await fetch(`${url}/health/ready`);

    expect(response.status).toBe(503);
  });

  test('SQS unreachable → 503', async () => {
    const url = await startApp(queueDown(config));

    const response = await fetch(`${url}/health/ready`);

    expect(response.status).toBe(503);
  });

  test('a queue that does not exist → 503', async () => {
    const url = await startApp({ ...config, sqs: { ...config.sqs, wageringEventsQueue: `missing-${Bun.randomUUIDv7()}.fifo` } });

    const response = await fetch(`${url}/health/ready`);

    expect(response.status).toBe(503);
  });
});

describe('liveness', () => {
  test.each([
    ['both up', (base: AppConfig) => base],
    ['PostgreSQL unreachable', databaseDown],
    ['SQS unreachable', queueDown],
  ])('%s → 200', async (_, configure) => {
    const url = await startApp(configure(config));

    const response = await fetch(`${url}/health/live`);

    expect(response.status).toBe(200);
  });
});

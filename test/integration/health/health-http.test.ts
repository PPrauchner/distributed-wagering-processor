/**
 * `/health/live` and `/health/ready` end to end, against the real PostgreSQL
 * and the real LocalStack: readiness answers 200 only with the database and the
 * input, event and dead-letter queues up, and 503 when any is unreachable —
 * with the reason of each probe down, its error's name, logged as a warning;
 * liveness answers 200 regardless.
 *
 * @packageDocumentation
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { INestApplication } from '@nestjs/common';
import { createApp } from '../../../src/app.ts';
import { loadConfig, type AppConfig } from '../../../src/config.ts';

const apps: INestApplication[] = [];
let config: AppConfig;
let logLines: string[] = [];

async function startApp(appConfig: AppConfig): Promise<string> {
  const app = await createApp(appConfig, { logDestination: { write: (line: string) => void logLines.push(line) } });
  await app.listen(0, '127.0.0.1');
  apps.push(app);
  return app.getUrl();
}

beforeAll(() => {
  config = loadConfig();
});

beforeEach(() => {
  logLines = [];
});

interface Report {
  ready: boolean;
  checks: Record<string, string>;
  reasons: Record<string, string>;
}

function warnings(): Record<string, unknown>[] {
  return logLines
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((entry) => entry.msg === 'readiness probe failed');
}

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
  test('PostgreSQL and SQS up → 200, the DLQ among the probes', async () => {
    const url = await startApp(config);

    const response = await fetch(`${url}/health/ready`);

    expect(response.status).toBe(200);
    const report = (await response.json()) as Report;
    expect(report.checks[`queue:${config.sqs.wagerTransactionsDlq}`]).toBe('up');
    expect(report.reasons).toEqual({});
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

  test('a queue that does not exist → 503, with the reason of that probe, logged as a warning', async () => {
    const missing = `missing-${Bun.randomUUIDv7()}.fifo`;
    const url = await startApp({ ...config, sqs: { ...config.sqs, wageringEventsQueue: missing } });

    const response = await fetch(`${url}/health/ready`);

    expect(response.status).toBe(503);
    const report = (await response.json()) as Report;
    const probe = `queue:${missing}`;
    expect(report.checks[probe]).toBe('down');
    expect(Object.keys(report.reasons)).toEqual([probe]);
    expect(report.reasons[probe]).toMatch(/^\w+$/);
    expect(warnings()).toContainEqual(expect.objectContaining({ level: 40, probe, error: report.reasons[probe] }));
  });

  test('a DLQ that does not exist → 503: the DLQ is a probe', async () => {
    const missing = `missing-dlq-${Bun.randomUUIDv7()}.fifo`;
    const url = await startApp({ ...config, sqs: { ...config.sqs, wagerTransactionsDlq: missing } });

    const response = await fetch(`${url}/health/ready`);

    expect(response.status).toBe(503);
    expect(((await response.json()) as Report).reasons).toHaveProperty([`queue:${missing}`]);
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

/**
 * Unit tests for `SqsQueueDepth`: every request it sends carries the caller's
 * abort signal, so a read that outlived its time limit is cancelled, not left
 * hanging on the client.
 *
 * @packageDocumentation
 */
import { describe, expect, test } from 'bun:test';
import type { SQSClient } from '@aws-sdk/client-sqs';
import { SqsQueueDepth } from '../../../src/health/infrastructure/sqs-queue-depth.ts';

/** A client answering both requests, recording the abort signal of each. */
function clientSpy(): { client: SQSClient; signals: (AbortSignal | undefined)[] } {
  const signals: (AbortSignal | undefined)[] = [];
  const client = {
    send: async (_command: unknown, options?: { abortSignal?: AbortSignal }) => {
      signals.push(options?.abortSignal);
      return { QueueUrl: 'http://queue/dlq', Attributes: { ApproximateNumberOfMessages: '3' } };
    },
  } as unknown as SQSClient;
  return { client, signals };
}

describe('reading a queue depth', () => {
  test('sends every request with the given abort signal', async () => {
    const { client, signals } = clientSpy();
    const signal = new AbortController().signal;

    const depth = await new SqsQueueDepth(client, 'dlq').read(signal);

    expect(depth).toBe(3);
    expect(signals).toEqual([signal, signal]);
  });
});

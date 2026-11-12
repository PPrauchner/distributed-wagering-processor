/**
 * Unit tests for `SqsEventPublisher`: an entry the queue refuses is reported
 * by its SQS error code only — the free text SQS sends with it goes to the
 * logs, and the rule is never to log an error's message. The SQS client is a
 * fake that answers the batch with one refused entry.
 *
 * @packageDocumentation
 */
import { describe, expect, test } from 'bun:test';
import type { SQSClient } from '@aws-sdk/client-sqs';
import { SendMessageBatchCommand } from '@aws-sdk/client-sqs';
import { SqsEventPublisher } from '../../../src/messaging/infrastructure/sqs-event-publisher.ts';
import { OutboxMessage } from '../../../src/messaging/domain/outbox-message.ts';

const WALLET_ID = '0192f291-27dd-7d3f-8071-5f8685deef37';

const message = (id: string): OutboxMessage =>
  OutboxMessage.rehydrate({
    id,
    aggregateId: WALLET_ID,
    eventType: 'WalletBalanceChanged',
    walletId: WALLET_ID,
    payload: { secret: 'payload' },
    occurredAt: new Date('2026-11-10T12:00:00.000Z'),
    attempts: 0,
  });

/** Answers every batch by accepting entry 0 and refusing entry 1. */
function fakeSqs(): SQSClient {
  return {
    send: async (command: unknown) =>
      command instanceof SendMessageBatchCommand
        ? {
            Successful: [{ Id: '0' }],
            Failed: [{ Id: '1', Code: 'InternalError', SenderFault: false, Message: 'amount 123.45 rejected' }],
          }
        : { QueueUrl: 'http://queue' },
  } as unknown as SQSClient;
}

describe('an entry the queue refuses', () => {
  test('is reported by its SQS error code, never the message SQS sends with it', async () => {
    const result = await new SqsEventPublisher(fakeSqs(), 'events').publish([message('m-1'), message('m-2')]);

    expect(result).toEqual({ published: ['m-1'], failed: [{ id: 'm-2', reason: 'InternalError' }] });
  });
});

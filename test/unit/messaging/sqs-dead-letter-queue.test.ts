/**
 * Unit tests for `SqsDeadLetterQueue`: what it asks SQS to send — the original
 * attributes plus `failureCode`, within the 10 attributes SQS takes per
 * message. The SQS client is a fake that records the commands.
 *
 * @packageDocumentation
 */
import { describe, expect, test } from 'bun:test';
import type { SQSClient, SendMessageCommandInput } from '@aws-sdk/client-sqs';
import { SendMessageCommand } from '@aws-sdk/client-sqs';
import { SqsDeadLetterQueue } from '../../../src/messaging/infrastructure/sqs-dead-letter-queue.ts';

function fakeSqs(sent: SendMessageCommandInput[]): SQSClient {
  return {
    send: async (command: unknown) => {
      if (command instanceof SendMessageCommand) sent.push(command.input);
      return { QueueUrl: 'http://queue' };
    },
  } as unknown as SQSClient;
}

describe('a letter sent to the DLQ', () => {
  test('keeps the original attributes and adds failureCode', async () => {
    const sent: SendMessageCommandInput[] = [];

    await new SqsDeadLetterQueue(fakeSqs(sent), 'dlq').send({
      body: 'body',
      attributes: { correlationId: 'correlation-1' },
      failureCode: 'INVALID_PAYLOAD',
      groupId: 'group',
      deduplicationId: 'dedup',
    });

    expect(Object.keys(sent[0]!.MessageAttributes!).sort()).toEqual(['correlationId', 'failureCode']);
  });

  test('with 10 original attributes, stays within the 10 SQS takes, failureCode and correlationId among them', async () => {
    const sent: SendMessageCommandInput[] = [];
    const attributes = Object.fromEntries(
      Array.from({ length: 9 }, (_, i) => [`attribute${i}`, `value${i}`]).concat([['correlationId', 'correlation-1']]),
    );

    await new SqsDeadLetterQueue(fakeSqs(sent), 'dlq').send({
      body: 'body',
      attributes,
      failureCode: 'INVALID_PAYLOAD',
      groupId: 'group',
      deduplicationId: 'dedup',
    });

    const sentAttributes = sent[0]!.MessageAttributes!;
    expect(Object.keys(sentAttributes)).toHaveLength(10);
    expect(sentAttributes.failureCode?.StringValue).toBe('INVALID_PAYLOAD');
    expect(sentAttributes.correlationId?.StringValue).toBe('correlation-1');
  });
});

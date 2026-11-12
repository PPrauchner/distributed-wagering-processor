/**
 * Unit tests for `InboxMessage`: a message received, then marked processed
 * once — the first time stays.
 *
 * @packageDocumentation
 */
import { describe, expect, test } from 'bun:test';
import { InboxMessage } from '../../../src/messaging/domain/inbox-message.ts';

const receivedAt = new Date('2026-11-10T12:00:00.000Z');

function received(): InboxMessage {
  return InboxMessage.receive({
    consumerName: 'wager-transactions-consumer',
    messageId: 'msg-123',
    payloadHash: 'a'.repeat(64),
    receivedAt,
  });
}

describe('InboxMessage', () => {
  test('a message just received is not processed yet', () => {
    const message = received();

    expect(message.consumerName).toBe('wager-transactions-consumer');
    expect(message.messageId).toBe('msg-123');
    expect(message.payloadHash).toBe('a'.repeat(64));
    expect(message.receivedAt).toEqual(receivedAt);
    expect(message.isProcessed()).toBe(false);
    expect(message.processedAt).toBeUndefined();
  });

  test('marked processed, it keeps the time of the first mark', () => {
    const message = received();
    const first = new Date('2026-11-10T12:00:01.000Z');

    message.markProcessed(first);
    message.markProcessed(new Date('2026-11-10T12:00:05.000Z'));

    expect(message.isProcessed()).toBe(true);
    expect(message.processedAt).toEqual(first);
  });

  test('rehydrates its persisted state as is', () => {
    const processedAt = new Date('2026-11-10T12:00:01.000Z');

    const message = InboxMessage.rehydrate({
      consumerName: 'c',
      messageId: 'm',
      payloadHash: 'b'.repeat(64),
      receivedAt,
      processedAt,
    });

    expect(message.isProcessed()).toBe(true);
    expect(message.processedAt).toEqual(processedAt);
  });

  test('refuses an empty consumer name or message id', () => {
    expect(() =>
      InboxMessage.receive({ consumerName: '', messageId: 'm', payloadHash: 'a'.repeat(64), receivedAt }),
    ).toThrow();
    expect(() =>
      InboxMessage.receive({ consumerName: 'c', messageId: '', payloadHash: 'a'.repeat(64), receivedAt }),
    ).toThrow();
  });
});

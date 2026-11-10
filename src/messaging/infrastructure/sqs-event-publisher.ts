/**
 * `EventPublisher` over SQS: one `SendMessageBatch` per batch, to the FIFO
 * event queue, with `MessageGroupId` = the wallet and `MessageDeduplicationId`
 * = the event id — a broker optimization, not the guarantee: the consumer
 * deduplicates by `eventId`. The queue URL is resolved by name on first use and
 * kept once found.
 *
 * @packageDocumentation
 */
import { GetQueueUrlCommand, SendMessageBatchCommand, type SQSClient } from '@aws-sdk/client-sqs';
import type { EventPublisher, PublishResult } from '../application/event-publisher.ts';
import type { OutboxMessage } from '../domain/outbox-message.ts';

export class SqsEventPublisher implements EventPublisher {
  private queueUrl: string | undefined;

  constructor(
    private readonly sqs: SQSClient,
    private readonly queueName: string,
  ) {}

  async publish(messages: readonly OutboxMessage[]): Promise<PublishResult> {
    if (messages.length === 0) return { published: [], failed: [] };
    const queueUrl = await this.resolveQueueUrl();
    // Batch entry ids only need to be unique in the batch: the position.
    const response = await this.sqs.send(
      new SendMessageBatchCommand({
        QueueUrl: queueUrl,
        Entries: messages.map((message, index) => ({
          Id: `${index}`,
          MessageBody: JSON.stringify(message.payload),
          MessageGroupId: message.walletId,
          MessageDeduplicationId: message.id,
        })),
      }),
    );
    const messageAt = (entryId: string | undefined): OutboxMessage | undefined => messages[Number(entryId)];
    const published = (response.Successful ?? []).flatMap((entry) => messageAt(entry.Id)?.id ?? []);
    const sent = new Set(published);
    return { published, failed: messages.map((message) => message.id).filter((id) => !sent.has(id)) };
  }

  private async resolveQueueUrl(): Promise<string> {
    if (this.queueUrl === undefined) {
      const { QueueUrl } = await this.sqs.send(new GetQueueUrlCommand({ QueueName: this.queueName }));
      if (QueueUrl === undefined) throw new Error(`queue ${this.queueName} has no URL`);
      this.queueUrl = QueueUrl;
    }
    return this.queueUrl;
  }
}

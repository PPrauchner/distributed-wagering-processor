/**
 * `DeadLetterQueue` over a FIFO SQS queue: `SendMessage` with the original
 * body and attributes plus the `failureCode` attribute, the group and the
 * deduplication id the consumer chose. The queue URL is resolved by name on
 * first use and kept once found.
 *
 * @packageDocumentation
 */
import { GetQueueUrlCommand, SendMessageCommand, type SQSClient } from '@aws-sdk/client-sqs';
import type { DeadLetter, DeadLetterQueue } from '../application/dead-letter-queue.ts';

export class SqsDeadLetterQueue implements DeadLetterQueue {
  private queueUrl: string | undefined;

  constructor(
    private readonly sqs: SQSClient,
    private readonly queueName: string,
  ) {}

  async send(letter: DeadLetter): Promise<void> {
    const attributes = { ...letter.attributes, failureCode: letter.failureCode };
    await this.sqs.send(
      new SendMessageCommand({
        QueueUrl: await this.resolveQueueUrl(),
        MessageBody: letter.body,
        MessageAttributes: Object.fromEntries(
          Object.entries(attributes).map(([name, value]) => [name, { DataType: 'String', StringValue: value }]),
        ),
        MessageGroupId: letter.groupId,
        MessageDeduplicationId: letter.deduplicationId,
      }),
    );
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

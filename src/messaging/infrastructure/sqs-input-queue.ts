/**
 * `InputQueue` over SQS: `ReceiveMessage` with long polling, batch size and
 * visibility timeout fixed by the configuration, and `DeleteMessage` as the
 * `ack`. The queue URL is resolved by name on first use and kept once found.
 *
 * @packageDocumentation
 */
import { DeleteMessageCommand, GetQueueUrlCommand, ReceiveMessageCommand, type SQSClient } from '@aws-sdk/client-sqs';
import type { InputQueue, ReceivedMessage } from '../application/input-queue.ts';

export interface SqsInputQueueOptions {
  queueName: string;
  waitTimeSeconds: number;
  batchSize: number;
  visibilityTimeoutSeconds: number;
}

export class SqsInputQueue implements InputQueue {
  private queueUrl: string | undefined;

  constructor(
    private readonly sqs: SQSClient,
    private readonly options: SqsInputQueueOptions,
  ) {}

  async receive(): Promise<ReceivedMessage[]> {
    const { Messages = [] } = await this.sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: await this.resolveQueueUrl(),
        WaitTimeSeconds: this.options.waitTimeSeconds,
        MaxNumberOfMessages: this.options.batchSize,
        VisibilityTimeout: this.options.visibilityTimeoutSeconds,
        MessageAttributeNames: ['All'],
      }),
    );
    return Messages.flatMap((message) => {
      if (message.Body === undefined || message.ReceiptHandle === undefined) return [];
      const attributes = Object.fromEntries(
        Object.entries(message.MessageAttributes ?? {}).flatMap(([name, value]) =>
          value.StringValue === undefined ? [] : [[name, value.StringValue] as const],
        ),
      );
      return [{ body: message.Body, attributes, receipt: message.ReceiptHandle }];
    });
  }

  async acknowledge(message: ReceivedMessage): Promise<void> {
    await this.sqs.send(
      new DeleteMessageCommand({ QueueUrl: await this.resolveQueueUrl(), ReceiptHandle: message.receipt }),
    );
  }

  private async resolveQueueUrl(): Promise<string> {
    if (this.queueUrl === undefined) {
      const { QueueUrl } = await this.sqs.send(new GetQueueUrlCommand({ QueueName: this.options.queueName }));
      if (QueueUrl === undefined) throw new Error(`queue ${this.options.queueName} has no URL`);
      this.queueUrl = QueueUrl;
    }
    return this.queueUrl;
  }
}

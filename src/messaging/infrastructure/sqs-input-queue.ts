/**
 * `InputQueue` over SQS: `ReceiveMessage` with long polling, batch size and
 * visibility timeout fixed by the configuration, with each message's
 * `ApproximateReceiveCount`; `DeleteMessage` as the `ack` and
 * `ChangeMessageVisibility` to hand a delivery back. The queue URL is resolved
 * by name on first use and kept once found.
 *
 * @packageDocumentation
 */
import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  GetQueueUrlCommand,
  ReceiveMessageCommand,
  type SQSClient,
} from '@aws-sdk/client-sqs';
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

  async receive(signal?: AbortSignal): Promise<ReceivedMessage[]> {
    const queueUrl = await this.resolveQueueUrl();
    if (signal?.aborted) return [];
    let Messages;
    try {
      ({ Messages = [] } = await this.sqs.send(
        new ReceiveMessageCommand({
          QueueUrl: queueUrl,
          WaitTimeSeconds: this.options.waitTimeSeconds,
          MaxNumberOfMessages: this.options.batchSize,
          VisibilityTimeout: this.options.visibilityTimeoutSeconds,
          MessageAttributeNames: ['All'],
          MessageSystemAttributeNames: ['ApproximateReceiveCount'],
        }),
        { abortSignal: signal },
      ));
    } catch (error) {
      if (signal?.aborted) return [];
      throw error;
    }
    return Messages.flatMap((message) => {
      if (message.Body === undefined || message.ReceiptHandle === undefined || message.MessageId === undefined) return [];
      const attributes = Object.fromEntries(
        Object.entries(message.MessageAttributes ?? {}).flatMap(([name, value]) =>
          value.StringValue === undefined ? [] : [[name, value.StringValue] as const],
        ),
      );
      const receiveCount = Number(message.Attributes?.ApproximateReceiveCount ?? 1);
      return [{ body: message.Body, attributes, deliveryId: message.MessageId, receipt: message.ReceiptHandle, receiveCount }];
    });
  }

  async acknowledge(message: ReceivedMessage): Promise<void> {
    await this.sqs.send(
      new DeleteMessageCommand({ QueueUrl: await this.resolveQueueUrl(), ReceiptHandle: message.receipt }),
    );
  }

  async changeVisibility(message: ReceivedMessage, seconds: number): Promise<void> {
    await this.sqs.send(
      new ChangeMessageVisibilityCommand({
        QueueUrl: await this.resolveQueueUrl(),
        ReceiptHandle: message.receipt,
        VisibilityTimeout: seconds,
      }),
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

/**
 * How many messages wait in one SQS queue: its `ApproximateNumberOfMessages`,
 * read from the broker — so it counts what any process sent there, the DLQ's
 * native redrive included, and survives a restart. The queue URL is resolved
 * by name and kept once found.
 *
 * @packageDocumentation
 */
import { GetQueueAttributesCommand, GetQueueUrlCommand, type SQSClient } from '@aws-sdk/client-sqs';

export class SqsQueueDepth {
  private queueUrl: string | undefined;

  constructor(
    private readonly sqs: SQSClient,
    private readonly queueName: string,
  ) {}

  /**
   * @returns The queue's approximate number of visible messages.
   * @throws Whatever SQS answered, if the queue cannot be read.
   */
  async read(): Promise<number> {
    const { Attributes } = await this.sqs.send(
      new GetQueueAttributesCommand({
        QueueUrl: await this.resolveQueueUrl(),
        AttributeNames: ['ApproximateNumberOfMessages'],
      }),
    );
    return Number(Attributes?.ApproximateNumberOfMessages ?? 0);
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

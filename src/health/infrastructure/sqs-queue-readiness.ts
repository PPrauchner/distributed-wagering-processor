/**
 * Readiness probe of one SQS queue: `GetQueueAttributes` on it, resolving its
 * URL by name. Its client should not retry: a probe answers within its timeout.
 *
 * @packageDocumentation
 */
import { GetQueueAttributesCommand, GetQueueUrlCommand, type SQSClient } from '@aws-sdk/client-sqs';
import type { ReadinessProbe } from '../application/check-readiness.ts';

export class SqsQueueReadiness implements ReadinessProbe {
  readonly name: string;

  constructor(
    private readonly sqs: SQSClient,
    private readonly queueName: string,
  ) {
    this.name = `queue:${queueName}`;
  }

  async check(signal: AbortSignal): Promise<void> {
    const { QueueUrl } = await this.sqs.send(new GetQueueUrlCommand({ QueueName: this.queueName }), {
      abortSignal: signal,
    });
    await this.sqs.send(new GetQueueAttributesCommand({ QueueUrl, AttributeNames: ['QueueArn'] }), {
      abortSignal: signal,
    });
  }
}

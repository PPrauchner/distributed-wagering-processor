/**
 * The real LocalStack queues of the concurrency suite: every scenario creates
 * its own, with a random suffix — an input queue with its DLQ, by the redrive
 * of the Compose, and an events queue —, sends §10 envelopes to the input
 * queue and reads what reached the events queue.
 *
 * @packageDocumentation
 */
import {
  CreateQueueCommand,
  DeleteMessageBatchCommand,
  DeleteQueueCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { loadConfig } from '../../../src/config.ts';

type JsonObject = Record<string, unknown>;

export interface Queue {
  name: string;
  url: string;
}

/** What a scenario's instances share: the input queue, its DLQ and the events queue. */
export interface ScenarioQueues {
  input: Queue;
  dlq: Queue;
  events: Queue;
}

/** An event as it reached the events queue. */
export interface ReceivedEvent {
  eventId: string;
  deduplicationId: string | undefined;
}

/** The redrive of the Compose: the safety net past the consumer's five receives. */
const MAX_RECEIVE_COUNT = '6';

const config = loadConfig();
export const sqs = new SQSClient({
  endpoint: config.sqs.endpoint,
  region: config.sqs.region,
  credentials: { accessKeyId: config.sqs.accessKeyId, secretAccessKey: config.sqs.secretAccessKey },
});

const created: string[] = [];

/** @returns New queues, with a random suffix, for one scenario. */
export async function createScenarioQueues(): Promise<ScenarioQueues> {
  const suffix = Bun.randomUUIDv7().slice(-12);
  const dlq = await createQueue(`wager-transactions-dlq-${suffix}.fifo`);
  const { Attributes = {} } = await sqs.send(
    new GetQueueAttributesCommand({ QueueUrl: dlq.url, AttributeNames: ['QueueArn'] }),
  );
  const input = await createQueue(`wager-transactions-${suffix}.fifo`, {
    RedrivePolicy: JSON.stringify({ deadLetterTargetArn: Attributes.QueueArn, maxReceiveCount: MAX_RECEIVE_COUNT }),
  });
  const events = await createQueue(`wagering-events-${suffix}.fifo`);
  return { input, dlq, events };
}

async function createQueue(name: string, attributes: Record<string, string> = {}): Promise<Queue> {
  const { QueueUrl } = await sqs.send(
    new CreateQueueCommand({ QueueName: name, Attributes: { FifoQueue: 'true', ...attributes } }),
  );
  created.push(QueueUrl!);
  return { name, url: QueueUrl! };
}

/** Deletes every queue this run created; for `afterAll`. */
export async function deleteScenarioQueues(): Promise<void> {
  await Promise.all(
    created.splice(0).map((QueueUrl) => sqs.send(new DeleteQueueCommand({ QueueUrl })).catch(() => undefined)),
  );
}

/**
 * Sends a submission as a new `WagerTransactionRequested` message, grouped by wallet.
 *
 * @param queue - The input queue.
 * @param data - The submission, as the §10 envelope's `data`.
 * @returns The envelope's `messageId`.
 */
export async function sendSubmission(queue: Queue, data: JsonObject): Promise<string> {
  const messageId = Bun.randomUUIDv7();
  await sqs.send(
    new SendMessageCommand({
      QueueUrl: queue.url,
      MessageBody: JSON.stringify({
        messageId,
        type: 'WagerTransactionRequested',
        occurredAt: new Date().toISOString(),
        data,
      }),
      MessageGroupId: String(data.walletId),
      MessageDeduplicationId: Bun.randomUUIDv7(),
    }),
  );
  return messageId;
}

/** @returns The messages in the queue, visible or in flight. */
export async function messagesLeft(queue: Queue): Promise<number> {
  const { Attributes = {} } = await sqs.send(
    new GetQueueAttributesCommand({
      QueueUrl: queue.url,
      AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'],
    }),
  );
  return Number(Attributes.ApproximateNumberOfMessages) + Number(Attributes.ApproximateNumberOfMessagesNotVisible);
}

/** @returns `true` once nothing is left in the queue — for `waitUntil`. */
export async function drained(queue: Queue): Promise<true | undefined> {
  return (await messagesLeft(queue)) === 0 ? true : undefined;
}

/**
 * One receive from the events queue, deleting what arrived.
 *
 * @param queue - The events queue.
 * @returns Every event received, duplicates included, in arrival order.
 */
export async function receiveEvents(queue: Queue): Promise<ReceivedEvent[]> {
  const { Messages = [] } = await sqs.send(
    new ReceiveMessageCommand({
      QueueUrl: queue.url,
      MaxNumberOfMessages: 10,
      WaitTimeSeconds: 0,
      MessageSystemAttributeNames: ['MessageDeduplicationId'],
    }),
  );
  if (Messages.length > 0) {
    await sqs.send(
      new DeleteMessageBatchCommand({
        QueueUrl: queue.url,
        Entries: Messages.map((message, index) => ({ Id: `${index}`, ReceiptHandle: message.ReceiptHandle! })),
      }),
    );
  }
  return Messages.map((message) => ({
    eventId: (JSON.parse(message.Body!) as JsonObject).eventId as string,
    deduplicationId: message.Attributes?.MessageDeduplicationId,
  }));
}

/**
 * Unit tests for `WagerTransactionConsumer` on its failure path: what each
 * outcome or error of the use case does to the message — `ack`, a retry with
 * `min(2^receiveCount s, ceiling)` of visibility, `FAILED` + DLQ — an error
 * that escapes unclassified as `INFRA_UNEXPECTED` —, or the DLQ
 * as a submission not admitted, with its `rejected_submissions` row — a
 * transient failure out of receives included —, the batch processed one
 * message at a time within each FIFO group and the groups in parallel, and the
 * shutdown that drains the messages in progress. The queue, the DLQ and the
 * use cases are fakes; the end to end lives in the integration tests.
 *
 * @packageDocumentation
 */
import { describe, expect, test } from 'bun:test';
import type { ConsumerMetrics } from '../../../src/messaging/application/consumer-metrics.ts';
import type { DeadLetter, DeadLetterQueue } from '../../../src/messaging/application/dead-letter-queue.ts';
import { InboxRedeliveryError, MessageIdConflictError } from '../../../src/messaging/application/inbox-repository.ts';
import type { InputQueue, ReceivedMessage } from '../../../src/messaging/application/input-queue.ts';
import type { ContextLog } from '../../../src/shared/application/context-log.ts';
import { TransientFailureError } from '../../../src/shared/application/infrastructure-failures.ts';
import { FailureCode } from '../../../src/shared/domain/failure-code.ts';
import type {
  ProcessWagerTransaction,
  WagerTransactionOutcome,
} from '../../../src/wagering/application/process-wager-transaction.ts';
import type {
  RecordRejectedSubmission,
  RecordRejectedSubmissionCommand,
} from '../../../src/wagering/application/record-rejected-submission.ts';
import {
  ExternalIdConflictError,
  FailedRedeliveryError,
  IdempotencyConflictError,
  InternalKindNotAllowedError,
  SubmissionWalletNotFoundError,
} from '../../../src/wagering/application/wagering-errors.ts';
import { WagerTransactionConsumer } from '../../../src/wagering/interface/wager-transaction.consumer.ts';

const WALLET_ID = '01890a5d-ac96-774b-bcce-b302099a8057';
const MESSAGE_ID = 'message-1';
const DELIVERY_ID = 'delivery-1';

const DATA = {
  providerId: 'provider-a',
  externalTransactionId: 'external-1',
  idempotencyKey: 'provider-a:external-1',
  playerId: 'player-1',
  walletId: WALLET_ID,
  roundId: 'round-1',
  gameId: 'game-1',
  kind: 'BET',
  money: { amount: '25.00', currency: 'BRL' },
};

/** A delivery of one queue message: its redeliveries keep the `deliveryId`, a message sent again gets another. */
function messageOf(receiveCount = 1, body: string = envelope(), deliveryId = DELIVERY_ID): ReceivedMessage {
  return {
    body,
    attributes: { correlationId: 'correlation-1' },
    deliveryId,
    receipt: `receipt-${receiveCount}`,
    receiveCount,
  };
}

function envelope(data: object = DATA): string {
  return JSON.stringify({ messageId: MESSAGE_ID, type: 'WagerTransactionRequested', occurredAt: '2026-11-11T00:00:00Z', data });
}

function outcome(status: string, failureCode?: string): WagerTransactionOutcome {
  return { transaction: { id: 'transaction-1', status, failureCode }, idempotentReplay: false } as unknown as WagerTransactionOutcome;
}

type Answer = () => Promise<WagerTransactionOutcome>;

interface Harness {
  consumer: WagerTransactionConsumer;
  acknowledged: string[];
  visibility: [string, number][];
  deadLetters: DeadLetter[];
  rejected: RecordRejectedSubmissionCommand[];
  retries: string[];
  dlqCodes: string[];
}

function harness(
  options: {
    execute?: Answer;
    dlqFails?: boolean;
    recordFails?: boolean;
    maxReceives?: number;
    retryMaxSeconds?: number;
    receive?: (signal?: AbortSignal) => Promise<ReceivedMessage[]>;
    drainTimeoutMs?: number;
  } = {},
): Harness {
  const h = {
    acknowledged: [] as string[],
    visibility: [] as [string, number][],
    deadLetters: [] as DeadLetter[],
    rejected: [] as RecordRejectedSubmissionCommand[],
    retries: [] as string[],
    dlqCodes: [] as string[],
  };
  const queue: InputQueue = {
    receive: options.receive ?? (async () => []),
    acknowledge: async (message) => void h.acknowledged.push(message.receipt),
    changeVisibility: async (message, seconds) => void h.visibility.push([message.receipt, seconds]),
  };
  const deadLetters: DeadLetterQueue = {
    send: async (letter) => {
      if (options.dlqFails) throw new Error('DLQ unavailable');
      h.deadLetters.push(letter);
    },
  };
  const processWagerTransaction = {
    execute: options.execute ?? (async () => outcome('PROCESSED')),
  } as unknown as ProcessWagerTransaction;
  const recordRejectedSubmission = {
    execute: async (command: RecordRejectedSubmissionCommand) => {
      if (options.recordFails) throw new TransientFailureError(FailureCode.TransientUnavailable);
      h.rejected.push(command);
    },
  } as unknown as RecordRejectedSubmission;
  const metrics: ConsumerMetrics = {
    inboxDuplicate: () => undefined,
    consumerRetry: (code) => void h.retries.push(code),
    deadLettered: (code) => void h.dlqCodes.push(code),
  };
  const log: ContextLog = {
    inContext: (_fields, work) => work(),
    enrich: () => undefined,
    info: () => undefined,
    warn: () => undefined,
  };
  const consumer = new WagerTransactionConsumer(
    {
      queue,
      deadLetters,
      processWagerTransaction,
      recordRejectedSubmission,
      metrics,
      log,
      faults: { inject: async () => undefined },
    },
    {
      enabled: options.receive !== undefined,
      maxReceives: options.maxReceives ?? 5,
      retryMaxSeconds: options.retryMaxSeconds ?? 60,
      drainTimeoutMs: options.drainTimeoutMs ?? 1000,
    },
  );
  return Object.assign(h, { consumer });
}

function failWith(error: Error): Answer {
  return async () => {
    throw error;
  };
}

describe('a transaction outcome', () => {
  test.each(['PROCESSED', 'REJECTED', 'PENDING_REFERENCE'])('%s is acknowledged, with nothing in the DLQ', async (status) => {
    const h = harness({ execute: async () => outcome(status) });

    await h.consumer.handle(messageOf());

    expect(h.acknowledged).toEqual(['receipt-1']);
    expect(h.deadLetters).toEqual([]);
  });

  test('a redelivery the inbox already holds is acknowledged with no DLQ', async () => {
    const h = harness({ execute: failWith(new InboxRedeliveryError('duplicate')) });

    await h.consumer.handle(messageOf(2));

    expect(h.acknowledged).toEqual(['receipt-2']);
    expect(h.deadLetters).toEqual([]);
  });
});

describe('a transient failure', () => {
  test('is not acknowledged: the delivery comes back after 2^receiveCount s, and the retry is counted', async () => {
    const h = harness({ execute: failWith(new TransientFailureError(FailureCode.TransientLockTimeout)) });

    await h.consumer.handle(messageOf(3));

    expect(h.acknowledged).toEqual([]);
    expect(h.visibility).toEqual([['receipt-3', 8]]);
    expect(h.retries).toEqual([FailureCode.TransientLockTimeout]);
    expect(h.deadLetters).toEqual([]);
  });

  test('the backoff stops at its ceiling', async () => {
    const h = harness({
      execute: failWith(new TransientFailureError(FailureCode.TransientUnavailable)),
      maxReceives: 10,
      retryMaxSeconds: 60,
    });

    await h.consumer.handle(messageOf(7));

    expect(h.visibility).toEqual([['receipt-7', 60]]);
  });

  test('on the last receive, it ends with no outcome: the DLQ as INFRA_RETRIES_EXHAUSTED, a rejected row, then the ack', async () => {
    const h = harness({ execute: failWith(new TransientFailureError(FailureCode.TransientLockTimeout)) });

    await h.consumer.handle(messageOf(5));

    expect(h.deadLetters).toEqual([
      {
        body: envelope(),
        attributes: { correlationId: 'correlation-1' },
        failureCode: FailureCode.InfraRetriesExhausted,
        groupId: WALLET_ID,
        deduplicationId: DELIVERY_ID,
      },
    ]);
    expect(h.dlqCodes).toEqual([FailureCode.InfraRetriesExhausted]);
    expect(h.rejected).toMatchObject([
      { failureCode: FailureCode.InfraRetriesExhausted, channel: 'QUEUE', messageId: MESSAGE_ID },
    ]);
    expect(h.rejected[0]!.payloadHash).toMatch(/^[0-9a-f]{64}$/);
    expect(h.acknowledged).toEqual(['receipt-5']);
  });

  test('the same envelope sent again from the DLQ and out of receives again reaches the DLQ under another deduplication id', async () => {
    const h = harness({ execute: failWith(new TransientFailureError(FailureCode.TransientLockTimeout)) });

    await h.consumer.handle(messageOf(5));
    await h.consumer.handle(messageOf(5, envelope(), 'delivery-2'));

    expect(h.deadLetters.map((letter) => letter.deduplicationId)).toEqual([DELIVERY_ID, 'delivery-2']);
  });

  test('when the DLQ fails on the last receive, the message is left for the redrive: no rejected row, no ack', async () => {
    const h = harness({ execute: failWith(new TransientFailureError(FailureCode.TransientUnavailable)), dlqFails: true });

    await h.consumer.handle(messageOf(5));

    expect(h.rejected).toEqual([]);
    expect(h.acknowledged).toEqual([]);
  });

  test('when the rejected row cannot be recorded on the last receive, the message is left for the redrive', async () => {
    const h = harness({ execute: failWith(new TransientFailureError(FailureCode.TransientUnavailable)), recordFails: true });

    await h.consumer.handle(messageOf(5));

    expect(h.acknowledged).toEqual([]);
  });
});

describe('a permanent error', () => {
  test('ends FAILED with the classifier code: sent to the DLQ with it, then acknowledged, with no rejected row', async () => {
    const h = harness({ execute: async () => outcome('FAILED', FailureCode.InfraInvariantViolation) });

    await h.consumer.handle(messageOf());

    expect(h.deadLetters.map((letter) => letter.failureCode)).toEqual([FailureCode.InfraInvariantViolation]);
    expect(h.acknowledged).toEqual(['receipt-1']);
    expect(h.rejected).toEqual([]);
  });

  test('a redelivery of a message recorded FAILED is sent to the DLQ again before the ack', async () => {
    const h = harness({
      execute: failWith(new FailedRedeliveryError(MESSAGE_ID, FailureCode.InfraInvariantViolation)),
    });

    await h.consumer.handle(messageOf(2));

    expect(h.deadLetters).toMatchObject([
      { failureCode: FailureCode.InfraInvariantViolation, groupId: WALLET_ID, deduplicationId: DELIVERY_ID },
    ]);
    expect(h.acknowledged).toEqual(['receipt-2']);
    expect(h.rejected).toEqual([]);
  });

  test('a redelivery of a FAILED whose DLQ send fails again stays unacknowledged', async () => {
    const h = harness({
      execute: failWith(new FailedRedeliveryError(MESSAGE_ID, FailureCode.InfraInvariantViolation)),
      dlqFails: true,
    });

    await h.consumer.handle(messageOf(2));

    expect(h.acknowledged).toEqual([]);
  });

  test('an unclassified error the use case recorded FAILED INFRA_UNEXPECTED goes to the DLQ with that code, then the ack', async () => {
    const h = harness({ execute: async () => outcome('FAILED', FailureCode.InfraUnexpected) });

    await h.consumer.handle(messageOf());

    expect(h.deadLetters).toMatchObject([
      { failureCode: FailureCode.InfraUnexpected, groupId: WALLET_ID, deduplicationId: DELIVERY_ID },
    ]);
    expect(h.acknowledged).toEqual(['receipt-1']);
    expect(h.visibility).toEqual([]);
    expect(h.rejected).toEqual([]);
  });

  test('an unclassified error that escapes the use case still goes to the DLQ as INFRA_UNEXPECTED, then the ack', async () => {
    const h = harness({ execute: failWith(new TypeError('cannot read properties of undefined')) });

    await h.consumer.handle(messageOf());

    expect(h.deadLetters).toMatchObject([
      { failureCode: FailureCode.InfraUnexpected, groupId: WALLET_ID, deduplicationId: DELIVERY_ID },
    ]);
    expect(h.dlqCodes).toEqual([FailureCode.InfraUnexpected]);
    expect(h.acknowledged).toEqual(['receipt-1']);
    expect(h.rejected).toEqual([]);
  });

  test('a DLQ that fails leaves the message unacknowledged', async () => {
    const h = harness({ execute: async () => outcome('FAILED', FailureCode.InfraUnexpected), dlqFails: true });

    await h.consumer.handle(messageOf());

    expect(h.acknowledged).toEqual([]);
  });
});

describe('a submission not admitted', () => {
  test('an invalid payload goes straight to the DLQ, with a rejected row of the queue channel, and is acknowledged', async () => {
    const body = JSON.stringify({ messageId: MESSAGE_ID, data: { ...DATA, money: 25 } });
    const h = harness();

    await h.consumer.handle(messageOf(1, body));

    expect(h.deadLetters).toEqual([
      {
        body,
        attributes: { correlationId: 'correlation-1' },
        failureCode: FailureCode.InvalidPayload,
        groupId: WALLET_ID,
        deduplicationId: DELIVERY_ID,
      },
    ]);
    expect(h.rejected).toEqual([
      {
        failureCode: FailureCode.InvalidPayload,
        channel: 'QUEUE',
        messageId: MESSAGE_ID,
        correlationId: 'correlation-1',
        providerId: 'provider-a',
        externalTransactionId: 'external-1',
        idempotencyKey: 'provider-a:external-1',
        payloadHash: undefined,
      },
    ] as never);
    expect(h.acknowledged).toEqual(['receipt-1']);
  });

  test('a body that is not even JSON still reaches the DLQ, deduplicated by its delivery', async () => {
    const h = harness();

    await h.consumer.handle(messageOf(1, 'not json'));

    expect(h.deadLetters).toHaveLength(1);
    expect(h.deadLetters[0]!.failureCode).toBe(FailureCode.InvalidPayload);
    expect(h.deadLetters[0]!.deduplicationId).toBe(DELIVERY_ID);
    expect(h.rejected).toHaveLength(1);
    expect(h.acknowledged).toEqual(['receipt-1']);
  });

  test.each([
    ['too long', 'm'.repeat(129)],
    ['not ASCII', 'mensagem-ção'],
    ['with a space', 'message 1'],
  ])('a messageId %s for SQS still reaches the DLQ, deduplicated by its delivery', async (_case, messageId) => {
    const body = JSON.stringify({ messageId, data: { ...DATA, money: 25 } });
    const h = harness();

    await h.consumer.handle(messageOf(1, body));

    expect(h.deadLetters).toHaveLength(1);
    expect(h.deadLetters[0]!.deduplicationId).toBe(DELIVERY_ID);
    expect(h.acknowledged).toEqual(['receipt-1']);
  });

  test.each([
    ['too long', 'w'.repeat(129)],
    ['not ASCII', 'carteira-ção'],
    ['with a space', 'wallet 1'],
  ])('a walletId %s for SQS goes to the unroutable DLQ group', async (_case, walletId) => {
    const h = harness();

    await h.consumer.handle(messageOf(1, envelope({ ...DATA, walletId, money: 25 })));

    expect(h.deadLetters.map((letter) => letter.groupId)).toEqual(['unroutable']);
    expect(h.acknowledged).toEqual(['receipt-1']);
  });

  test.each([
    [new IdempotencyConflictError('provider-a', 'key', 'h'.repeat(64)), FailureCode.IdempotencyConflict],
    [new ExternalIdConflictError('provider-a', 'external-1', 'h'.repeat(64)), FailureCode.ExternalIdConflict],
    [new InternalKindNotAllowedError('OPENING', 'h'.repeat(64)), FailureCode.InternalKindNotAllowed],
    [new MessageIdConflictError(MESSAGE_ID, 'h'.repeat(64)), FailureCode.MessageIdConflict],
  ])('%p goes straight to the DLQ as %s, with its rejected row and payload hash', async (error, code) => {
    const h = harness({ execute: failWith(error) });

    await h.consumer.handle(messageOf());

    expect(h.deadLetters.map((letter) => letter.failureCode)).toEqual([code]);
    expect(h.rejected).toMatchObject([{ failureCode: code, channel: 'QUEUE', payloadHash: 'h'.repeat(64) }]);
    expect(h.acknowledged).toEqual(['receipt-1']);
  });

  test('a missing wallet is retried like a transient failure, with no DLQ and no rejected row', async () => {
    const h = harness({ execute: failWith(new SubmissionWalletNotFoundError(WALLET_ID, 'h'.repeat(64))) });

    await h.consumer.handle(messageOf(2));

    expect(h.visibility).toEqual([['receipt-2', 4]]);
    expect(h.retries).toEqual([FailureCode.WalletNotFound]);
    expect(h.deadLetters).toEqual([]);
    expect(h.rejected).toEqual([]);
  });

  test('a wallet still missing on the last receive goes to the DLQ as WALLET_NOT_FOUND, never FAILED', async () => {
    const h = harness({ execute: failWith(new SubmissionWalletNotFoundError(WALLET_ID, 'h'.repeat(64))) });

    await h.consumer.handle(messageOf(5));

    expect(h.deadLetters.map((letter) => letter.failureCode)).toEqual([FailureCode.WalletNotFound]);
    expect(h.rejected).toMatchObject([{ failureCode: FailureCode.WalletNotFound }]);
    expect(h.acknowledged).toEqual(['receipt-5']);
  });

  test('a rejected row that cannot be recorded leaves the message unacknowledged', async () => {
    const h = harness({ execute: failWith(new IdempotencyConflictError('provider-a', 'key')), recordFails: true });

    await h.consumer.handle(messageOf());

    expect(h.acknowledged).toEqual([]);
  });
});

/** A long poll that waits until aborted, then resolves with what it is given. */
function abortableReceive(onAbort: () => ReceivedMessage[], started: () => void) {
  let calls = 0;
  return (signal?: AbortSignal) =>
    new Promise<ReceivedMessage[]>((resolve) => {
      if (calls++ === 0) started();
      signal?.addEventListener('abort', () => resolve(onAbort()));
    });
}

describe('on shutdown', () => {
  test('the long poll in progress is cut short, and the messages it brought are handed back at once, unprocessed', async () => {
    let processed = 0;
    let polling!: () => void;
    const pollStarted = new Promise<void>((resolve) => (polling = resolve));
    const h = harness({
      receive: abortableReceive(() => [messageOf(1)], polling),
      execute: async () => {
        processed++;
        return outcome('PROCESSED');
      },
    });
    h.consumer.onApplicationBootstrap();
    await pollStarted;

    await h.consumer.beforeApplicationShutdown();

    expect(processed).toBe(0);
    expect(h.visibility).toEqual([['receipt-1', 0]]);
    expect(h.acknowledged).toEqual([]);
  });

  test('the messages in progress are waited for, and acknowledged', async () => {
    let finish!: () => void;
    let inProgress!: () => void;
    const started = new Promise<void>((resolve) => (inProgress = resolve));
    let delivered = false;
    const h = harness({
      receive: async (signal) => {
        if (!delivered) {
          delivered = true;
          return [messageOf(1)];
        }
        return new Promise((resolve) => signal?.addEventListener('abort', () => resolve([])));
      },
      execute: () =>
        new Promise((resolve) => {
          finish = () => resolve(outcome('PROCESSED'));
          inProgress();
        }),
    });
    h.consumer.onApplicationBootstrap();
    await started;

    let stopped = false;
    const stopping = h.consumer.beforeApplicationShutdown().then(() => (stopped = true));
    await Bun.sleep(20);
    expect(stopped).toBe(false);

    finish();
    await stopping;
    expect(h.acknowledged).toEqual(['receipt-1']);
  });

  test('the wait for the messages in progress ends at the drain timeout', async () => {
    let inProgress!: () => void;
    const started = new Promise<void>((resolve) => (inProgress = resolve));
    const h = harness({
      receive: async () => [messageOf(1)],
      execute: () => {
        inProgress();
        return new Promise(() => undefined);
      },
      drainTimeoutMs: 50,
    });
    h.consumer.onApplicationBootstrap();
    await started;

    const began = performance.now();
    await h.consumer.beforeApplicationShutdown();

    expect(performance.now() - began).toBeLessThan(1000);
    expect(h.acknowledged).toEqual([]);
  });
});

/** A delivery in the FIFO group `groupId`, told apart by its `externalTransactionId`. */
function grouped(name: string, groupId?: string, receiveCount = 1): ReceivedMessage {
  const message = messageOf(receiveCount, envelope({ ...DATA, externalTransactionId: name }), `delivery-${name}`);
  return { ...message, receipt: name, groupId };
}

/** Hands the batch over once, then long-polls until the shutdown cuts it short. */
function oneBatch(batch: ReceivedMessage[]) {
  let delivered = false;
  return (signal?: AbortSignal) => {
    if (!delivered) {
      delivered = true;
      return Promise.resolve(batch);
    }
    return new Promise<ReceivedMessage[]>((resolve) => signal?.addEventListener('abort', () => resolve([])));
  };
}

interface Gate {
  /** The messages the use case was called with, in order. */
  started: string[];
  /** Finishes the call of that message with its answer. */
  finish: (name: string, answer?: Answer) => void;
  execute: Answer;
}

/** A use case whose every call waits until the test finishes it. */
function gate(): Gate {
  const started: string[] = [];
  const pending = new Map<string, (answer: Answer) => void>();
  return {
    started,
    finish: (name, answer = async () => outcome('PROCESSED')) => pending.get(name)!(answer),
    execute: ((command: { externalTransactionId: string }) => {
      started.push(command.externalTransactionId);
      return new Promise<Answer>((resolve) => pending.set(command.externalTransactionId, resolve)).then((answer) => answer());
    }) as unknown as Answer,
  };
}

describe('a batch with FIFO groups', () => {
  test('the messages of a group run one at a time, in order, and distinct groups run in parallel', async () => {
    const use = gate();
    const h = harness({ receive: oneBatch([grouped('a1', 'A'), grouped('a2', 'A'), grouped('b1', 'B')]), execute: use.execute });

    h.consumer.onApplicationBootstrap();
    await waitUntilTrue(() => use.started.length === 2);
    expect(use.started).toEqual(['a1', 'b1']);

    use.finish('b1');
    use.finish('a1');
    await waitUntilTrue(() => use.started.length === 3);
    expect(use.started).toEqual(['a1', 'b1', 'a2']);

    use.finish('a2');
    await waitUntilTrue(() => h.acknowledged.length === 3);
    await h.consumer.beforeApplicationShutdown();
    expect(h.acknowledged.sort()).toEqual(['a1', 'a2', 'b1']);
  });
});

async function waitUntilTrue(condition: () => boolean): Promise<void> {
  for (let tries = 0; !condition(); tries++) {
    if (tries > 200) throw new Error('condition not met');
    await Bun.sleep(5);
  }
}

describe('a group whose message is left in the queue', () => {
  test('the first goes to a retry: the next never reaches the use case and comes back with the same delay, after it', async () => {
    const use = gate();
    const h = harness({ receive: oneBatch([grouped('a1', 'A', 2), grouped('a2', 'A')]), execute: use.execute });

    h.consumer.onApplicationBootstrap();
    await waitUntilTrue(() => use.started.length === 1);
    use.finish('a1', failWith(new TransientFailureError(FailureCode.TransientLockTimeout)));
    await waitUntilTrue(() => h.visibility.length === 2);
    await h.consumer.beforeApplicationShutdown();

    expect(use.started).toEqual(['a1']);
    expect(h.visibility).toEqual([
      ['a1', 4],
      ['a2', 4],
    ]);
    expect(h.acknowledged).toEqual([]);
  });

  test('a message that cannot be settled holds the rest of its group, left to its visibility too, not the other groups', async () => {
    const use = gate();
    const h = harness({
      receive: oneBatch([grouped('a1', 'A'), grouped('a2', 'A'), grouped('b1', 'B')]),
      execute: use.execute,
      dlqFails: true,
    });

    h.consumer.onApplicationBootstrap();
    await waitUntilTrue(() => use.started.length === 2);
    use.finish('a1', async () => outcome('FAILED', FailureCode.InfraUnexpected));
    use.finish('b1');
    await waitUntilTrue(() => h.acknowledged.length === 1);
    await h.consumer.beforeApplicationShutdown();

    expect(use.started).toEqual(['a1', 'b1']);
    expect(h.visibility).toEqual([]);
    expect(h.acknowledged).toEqual(['b1']);
  });

  test('messages with no group are each processed on their own, in parallel', async () => {
    const use = gate();
    const h = harness({ receive: oneBatch([grouped('x1'), grouped('x2')]), execute: use.execute });

    h.consumer.onApplicationBootstrap();
    await waitUntilTrue(() => use.started.length === 2);
    use.finish('x1');
    use.finish('x2');
    await waitUntilTrue(() => h.acknowledged.length === 2);
    await h.consumer.beforeApplicationShutdown();
  });

  test('on shutdown, the rest of a group not started yet is handed back, unprocessed', async () => {
    const use = gate();
    const h = harness({ receive: oneBatch([grouped('a1', 'A'), grouped('a2', 'A')]), execute: use.execute });

    h.consumer.onApplicationBootstrap();
    await waitUntilTrue(() => use.started.length === 1);
    const stopping = h.consumer.beforeApplicationShutdown();
    use.finish('a1');
    await stopping;

    expect(use.started).toEqual(['a1']);
    expect(h.acknowledged).toEqual(['a1']);
    expect(h.visibility).toEqual([['a2', 0]]);
  });
});

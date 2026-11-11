/**
 * Opens the log context of each HTTP request, with the correlation id the
 * request carries in `X-Correlation-Id`, if any. When it carries none, the use
 * case generates one and adds it to the context: a single source, the same id
 * recorded on the transaction.
 *
 * @packageDocumentation
 */
import type { LogContextStore } from '../shared/infrastructure/pino-logging.ts';

// The slice of the platform request this middleware uses; keeps it off Express types.
interface HttpRequest {
  headers: Record<string, string | string[] | undefined>;
}

/**
 * @param context - The store the request's context lives in.
 * @returns The middleware, for `app.use`.
 */
export function logContextMiddleware(
  context: LogContextStore,
): (request: HttpRequest, response: unknown, next: () => void) => void {
  return (request, _response, next) => {
    const header = request.headers['x-correlation-id'];
    const correlationId = typeof header === 'string' && header.length > 0 ? header : undefined;
    context.run(correlationId === undefined ? {} : { correlationId }, next);
  };
}

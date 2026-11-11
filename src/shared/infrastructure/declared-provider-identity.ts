/**
 * The no-op `ProviderIdentity`: authentication is out of scope, so a request is
 * authenticated as the provider it declares — the body's `providerId` on a
 * submission, the route's on a query by external id. It never diverges.
 *
 * @packageDocumentation
 */
import type {
  AuthenticatedProvider,
  ProviderIdentity,
  ProviderIdentityRequest,
} from '../application/provider-identity.ts';

export class DeclaredProviderIdentity implements ProviderIdentity {
  async authenticate(request: ProviderIdentityRequest): Promise<AuthenticatedProvider> {
    return { providerId: request.params.providerId ?? declaredInBody(request.body) };
  }
}

function declaredInBody(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null || !('providerId' in body)) return undefined;
  return typeof body.providerId === 'string' ? body.providerId : undefined;
}

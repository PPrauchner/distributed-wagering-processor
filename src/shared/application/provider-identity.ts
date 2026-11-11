/**
 * `ProviderIdentity` port: resolves, from a request, the provider it is
 * authenticated as. The extension point of authentication, which this service
 * does not implement (`ARCHITECTURE.md` § Autenticação): the default
 * implementation trusts what the request declares; a real one — a token
 * checked against an identity provider — replaces it by swapping the Nest
 * provider bound to {@link PROVIDER_IDENTITY}.
 *
 * @packageDocumentation
 */

/** Injection token of the provider identity implementation. */
export const PROVIDER_IDENTITY = Symbol('ProviderIdentity');

/** The slice of an HTTP request an identity is resolved from. */
export interface ProviderIdentityRequest {
  path: string;
  headers: Record<string, string | string[] | undefined>;
  params: Record<string, string | undefined>;
  body: unknown;
}

/** The provider a request is authenticated as. */
export interface AuthenticatedProvider {
  /** `undefined` only when the request declares no provider and none was authenticated. */
  readonly providerId: string | undefined;
}

export interface ProviderIdentity {
  /**
   * @param request - The request to authenticate.
   * @returns The provider the request is authenticated as.
   */
  authenticate(request: ProviderIdentityRequest): Promise<AuthenticatedProvider>;
}

/** The provider a request declares is not the one it is authenticated as. */
export class ProviderIdentityMismatchError extends Error {
  override readonly name = 'ProviderIdentityMismatchError';

  constructor(declaredProviderId: string) {
    super(`the request is not authenticated as provider "${declaredProviderId}"`);
  }
}

/**
 * @param identity - The provider the request is authenticated as.
 * @param declaredProviderId - The provider the request declares.
 * @throws {@link ProviderIdentityMismatchError} If they differ.
 */
export function assertDeclaredProvider(identity: AuthenticatedProvider, declaredProviderId: string): void {
  if (identity.providerId !== declaredProviderId) throw new ProviderIdentityMismatchError(declaredProviderId);
}

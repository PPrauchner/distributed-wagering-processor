/**
 * HTTP guard of the provider identity: resolves, through the
 * {@link ProviderIdentity} port, the provider a request is authenticated as and
 * leaves it on the request, where controllers read it with
 * {@link CurrentProvider}. Applied to the wagering and wallet controllers; the
 * health and metrics routes stay open, and the queue has no guard — it is an
 * internal, trusted channel (`ARCHITECTURE.md` § Autenticação).
 *
 * @packageDocumentation
 */
import {
  Inject,
  Injectable,
  createParamDecorator,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import {
  PROVIDER_IDENTITY,
  type AuthenticatedProvider,
  type ProviderIdentity,
  type ProviderIdentityRequest,
} from '../application/provider-identity.ts';

const AUTHENTICATED_PROVIDER = Symbol('AuthenticatedProvider');

type GuardedRequest = ProviderIdentityRequest & { [AUTHENTICATED_PROVIDER]?: AuthenticatedProvider };

@Injectable()
export class ProviderIdentityGuard implements CanActivate {
  constructor(@Inject(PROVIDER_IDENTITY) private readonly identity: ProviderIdentity) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<GuardedRequest>();
    request[AUTHENTICATED_PROVIDER] = await this.identity.authenticate(request);
    return true;
  }
}

/** Controller parameter: the provider the guard authenticated the request as. */
export const CurrentProvider = createParamDecorator((_data: unknown, context: ExecutionContext) => {
  const provider = context.switchToHttp().getRequest<GuardedRequest>()[AUTHENTICATED_PROVIDER];
  if (provider === undefined) throw new Error('CurrentProvider used on a route without ProviderIdentityGuard');
  return provider;
});

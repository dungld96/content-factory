import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';

import type { AuthUser } from '@acf/contracts';

/** The authenticated caller, loaded from the database on every request (roles are not cached). */
export interface Actor {
  readonly userId: string;
  readonly user: AuthUser;
}

const actors = new WeakMap<Request, Actor>();

export function setActor(req: Request, actor: Actor): void {
  actors.set(req, actor);
}

export function getActor(req: Request): Actor | undefined {
  return actors.get(req);
}

/** Route parameter: the authenticated {@link Actor}. Throws on public routes (programming error). */
export const CurrentActor = createParamDecorator((_data: unknown, ctx: ExecutionContext) => {
  const actor = getActor(ctx.switchToHttp().getRequest<Request>());
  if (!actor) throw new Error('CurrentActor used on a route without an authenticated session');
  return actor;
});

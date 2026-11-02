import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { Request } from 'express';
import { AuthContext } from '../types/auth-context';

export const CurrentUser = createParamDecorator((_: unknown, ctx: ExecutionContext): AuthContext => {
  const request = ctx.switchToHttp().getRequest<Request>();
  if (!request.authContext) {
    throw new Error('CurrentUser decorator used without SessionAuthGuard on the route');
  }
  return request.authContext;
});

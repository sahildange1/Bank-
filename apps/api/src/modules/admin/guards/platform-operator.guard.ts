import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Request } from 'express';
import { PrismaService } from '../../../common/prisma/prisma.service';

/**
 * Must run after SessionAuthGuard. Platform permissions alone are not
 * enough to reach /admin: the caller must also (1) belong to the single
 * platform organization, which is checked live in the database, never from
 * anything the client sent, and (2) have a verified MFA factor — staff who
 * can act across every customer don't get a password-only path. Both
 * checks make a permission mistakenly granted inside a customer
 * organization inert.
 */
@Injectable()
export class PlatformOperatorGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const auth = request.authContext;
    if (!auth) throw new ForbiddenException();

    const org = await this.prisma.organization.findUnique({
      where: { id: auth.organizationId },
      select: { isPlatform: true, status: true },
    });
    if (!org || !org.isPlatform || org.status !== 'ACTIVE') {
      throw new ForbiddenException('Platform operator access required.');
    }

    const mfa = await this.prisma.mfaFactor.findFirst({
      where: { userId: auth.userId, verified: true },
      select: { id: true },
    });
    if (!mfa) {
      throw new ForbiddenException('Multi-factor authentication must be enrolled before using the admin API.');
    }
    return true;
  }
}

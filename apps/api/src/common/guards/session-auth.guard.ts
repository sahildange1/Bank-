import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { Request } from 'express';
import { PrismaService } from '../prisma/prisma.service';
import { SessionService } from '../../modules/auth/services/session.service';

const SESSION_COOKIE_NAME = 'cbp_session';

/**
 * Every protected endpoint runs this first. It never trusts anything the
 * client claims about identity — only the opaque session ID from the
 * httpOnly cookie, resolved against the database.
 */
@Injectable()
export class SessionAuthGuard implements CanActivate {
  constructor(
    private readonly sessionService: SessionService,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const sessionId = request.cookies?.[SESSION_COOKIE_NAME];

    if (!sessionId || typeof sessionId !== 'string') {
      throw new UnauthorizedException();
    }

    const session = await this.sessionService.validateAndTouch(sessionId);
    if (!session) {
      throw new UnauthorizedException();
    }

    const user = await this.prisma.user.findUnique({
      where: { id: session.userId },
      include: {
        userRoles: {
          include: { role: { include: { rolePermissions: { include: { permission: true } } } } },
        },
      },
    });

    if (!user || user.status !== 'ACTIVE') {
      throw new UnauthorizedException();
    }

    const permissions = new Set<string>();
    for (const userRole of user.userRoles) {
      for (const rp of userRole.role.rolePermissions) {
        permissions.add(rp.permission.key);
      }
    }

    request.authContext = {
      userId: user.id,
      organizationId: user.organizationId,
      sessionId: session.id,
      permissions: [...permissions],
    };

    return true;
  }
}

export { SESSION_COOKIE_NAME };

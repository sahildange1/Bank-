import { Injectable } from '@nestjs/common';
import * as crypto from 'crypto';
import { PrismaService } from '../../../common/prisma/prisma.service';

const SESSION_IDLE_TTL_MS = 30 * 60 * 1000; // 30 min idle
const SESSION_ABSOLUTE_TTL_MS = 12 * 60 * 60 * 1000; // 12 hr absolute cap

export interface SessionInfo {
  id: string;
  userId: string;
  expiresAt: Date;
}

/**
 * Sessions are opaque, high-entropy random IDs stored server-side in
 * Postgres — not JWTs — so a session can be instantly and reliably revoked
 * (logout, password reset, admin-forced logout) without waiting out a token
 * TTL. Redis caching of session lookups is a performance optimization for
 * later; correctness doesn't depend on it, so it's deferred rather than
 * introduced half-finished in this phase.
 */
@Injectable()
export class SessionService {
  constructor(private readonly prisma: PrismaService) {}

  private generateSessionId(): string {
    return crypto.randomBytes(32).toString('base64url');
  }

  async create(userId: string, deviceInfo: string | undefined, ipAddress: string | undefined): Promise<SessionInfo> {
    const session = await this.prisma.session.create({
      data: {
        id: this.generateSessionId(),
        userId,
        deviceInfo,
        ipAddress,
        expiresAt: new Date(Date.now() + SESSION_ABSOLUTE_TTL_MS),
      },
    });
    return { id: session.id, userId: session.userId, expiresAt: session.expiresAt };
  }

  /**
   * Validates a session and applies sliding idle-timeout: `lastSeenAt` is
   * refreshed, but `expiresAt` (the absolute cap) is never extended, so a
   * session can never outlive SESSION_ABSOLUTE_TTL_MS from creation no
   * matter how active the user is.
   */
  async validateAndTouch(sessionId: string): Promise<SessionInfo | null> {
    const session = await this.prisma.session.findUnique({ where: { id: sessionId } });
    if (!session || session.revokedAt) return null;
    if (session.expiresAt < new Date()) return null;

    const idleDeadline = new Date(session.lastSeenAt.getTime() + SESSION_IDLE_TTL_MS);
    if (idleDeadline < new Date()) {
      await this.revoke(sessionId);
      return null;
    }

    await this.prisma.session.update({
      where: { id: sessionId },
      data: { lastSeenAt: new Date() },
    });

    return { id: session.id, userId: session.userId, expiresAt: session.expiresAt };
  }

  async revoke(sessionId: string): Promise<void> {
    await this.prisma.session.updateMany({
      where: { id: sessionId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  /** Used on password reset/change: kill every other active session for the user. */
  async revokeAllForUser(userId: string): Promise<void> {
    await this.prisma.session.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }
}

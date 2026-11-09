/**
 * Provider abstraction for outbound channels (architecture decision #9:
 * email via a provider abstraction; SMS/push are stubbed interfaces only).
 * A real SMTP/SES implementation replaces MockEmailProvider by rebinding
 * the EMAIL_PROVIDER token — NotificationsService never changes.
 */
export const EMAIL_PROVIDER = Symbol('EMAIL_PROVIDER');

export interface OutboundEmail {
  to: string;
  subject: string;
  body: string;
}

export interface EmailProvider {
  send(email: OutboundEmail): Promise<void>;
}

/** Interface-only stubs (decision #9): no implementation is provided. */
export interface SmsProvider {
  send(to: string, body: string): Promise<void>;
}
export interface PushProvider {
  send(userId: string, title: string, body: string): Promise<void>;
}

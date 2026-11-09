import { Injectable, Logger } from '@nestjs/common';
import { EmailProvider, OutboundEmail } from './email-provider';

/**
 * Sandbox email provider: delivers nothing. Logs only the recipient and
 * subject — never the body, which may contain account or payment details.
 */
@Injectable()
export class MockEmailProvider implements EmailProvider {
  private readonly logger = new Logger(MockEmailProvider.name);

  async send(email: OutboundEmail): Promise<void> {
    this.logger.log(`[mock] email to ${email.to}: ${email.subject}`);
  }
}

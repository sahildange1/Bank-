import { Global, Module } from '@nestjs/common';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './services/notifications.service';
import { EMAIL_PROVIDER } from './providers/email-provider';
import { MockEmailProvider } from './providers/mock-email.provider';

// Global so feature modules (approvals, payments, ...) can call notify()
// without importing this module, the same way AuditModule works.
@Global()
@Module({
  controllers: [NotificationsController],
  providers: [NotificationsService, { provide: EMAIL_PROVIDER, useClass: MockEmailProvider }],
  exports: [NotificationsService],
})
export class NotificationsModule {}

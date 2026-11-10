import { Module } from '@nestjs/common';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { PlatformOperatorGuard } from './guards/platform-operator.guard';
import { OrganizationStateMachine } from './services/organization-state-machine';
import { AuthModule } from '../auth/auth.module'; // SessionAuthGuard needs SessionService

// AuditService and NotificationsService come from their @Global() modules.
@Module({
  imports: [AuthModule],
  controllers: [AdminController],
  providers: [AdminService, PlatformOperatorGuard, OrganizationStateMachine],
})
export class AdminModule {}

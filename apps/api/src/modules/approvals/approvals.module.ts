import { Module } from '@nestjs/common';
import { ApprovalsController } from './approvals.controller';
import { ApprovalsService } from './approvals.service';
import { PaymentsModule } from '../payments/payments.module';

@Module({
  imports: [PaymentsModule], // for PaymentStateMachine (exported by PaymentsModule since Phase 8)
  controllers: [ApprovalsController],
  providers: [ApprovalsService],
  exports: [ApprovalsService],
})
export class ApprovalsModule {}

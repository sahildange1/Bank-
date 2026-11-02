import { Module } from '@nestjs/common';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';
import { PaymentStateMachine } from './services/payment-state-machine';
import { PaymentExecutionService } from './services/payment-execution.service';
import { MockPaymentProviderService } from './services/mock-payment-provider.service';
import { BeneficiariesModule } from '../beneficiaries/beneficiaries.module';
import { LedgerModule } from '../ledger/ledger.module';

@Module({
  imports: [BeneficiariesModule, LedgerModule], // LedgerModule: PaymentExecutionService (Phase 10) posts via LedgerService
  controllers: [PaymentsController],
  providers: [PaymentsService, PaymentStateMachine, PaymentExecutionService, MockPaymentProviderService],
  exports: [PaymentsService, PaymentStateMachine, PaymentExecutionService], // Phase 9 (Approvals) needs the first two
})
export class PaymentsModule {}

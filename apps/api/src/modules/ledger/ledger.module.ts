import { Module } from '@nestjs/common';
import { LedgerService } from './services/ledger.service';
import { ReconciliationService } from './services/reconciliation.service';
import { LedgerController } from './ledger.controller';

// LedgerService — the only code path allowed to write balance-affecting
// rows — was needed starting Phase 6 (internal transfers) and implemented
// then; see its own doc comment for why. Phase 10 adds ReconciliationService
// (the nightly/on-demand drift-check job) and the controller that exposes
// it on demand, completing this module's own scope note.
@Module({
  controllers: [LedgerController],
  providers: [LedgerService, ReconciliationService],
  exports: [LedgerService, ReconciliationService],
})
export class LedgerModule {}

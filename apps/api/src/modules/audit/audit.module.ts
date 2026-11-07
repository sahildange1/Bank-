import { Global, Module } from '@nestjs/common';
import { AuditService } from './services/audit.service';
import { AuditController } from './audit.controller';

// Global: every module that mutates state needs AuditService (architecture
// §10 — audit writes happen in the same transaction as the change they
// describe). See services/audit.service.ts for why recording starts in
// Phase 4, and the read/query side (AuditController, GET /audit-events)
// in Phase 11.
@Global()
@Module({
  controllers: [AuditController],
  providers: [AuditService],
  exports: [AuditService],
})
export class AuditModule {}

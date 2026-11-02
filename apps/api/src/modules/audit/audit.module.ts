import { Global, Module } from '@nestjs/common';
import { AuditService } from './services/audit.service';

// Global: every module that mutates state needs AuditService (architecture
// §10 — audit writes happen in the same transaction as the change they
// describe). See services/audit.service.ts for why recording starts in
// Phase 4 even though the full audit system is Phase 11.
@Global()
@Module({
  providers: [AuditService],
  exports: [AuditService],
})
export class AuditModule {}

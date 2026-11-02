import { Controller, Post, UseGuards } from '@nestjs/common';
import { ReconciliationService } from './services/reconciliation.service';
import { SessionAuthGuard } from '../../common/guards/session-auth.guard';
import { PermissionsGuard } from '../../common/guards/permissions.guard';
import { RequirePermissions } from '../../common/decorators/require-permissions.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { AuthContext } from '../../common/types/auth-context';

@Controller('ledger')
@UseGuards(SessionAuthGuard, PermissionsGuard)
export class LedgerController {
  constructor(private readonly reconciliationService: ReconciliationService) {}

  /**
   * The "on-demand reconciliation job" from architecture §9. Runs
   * synchronously and returns the full report rather than queuing a job —
   * reconciling one organization's accounts is bounded and fast enough not
   * to need the async-worker treatment payment execution would (see the
   * Phase 10 write-up on why that part is still unbuilt).
   */
  @Post('reconcile')
  @RequirePermissions('ledger.reconcile')
  reconcile(@CurrentUser() user: AuthContext) {
    return this.reconciliationService.reconcileOrganization(user.organizationId, user.userId);
  }
}

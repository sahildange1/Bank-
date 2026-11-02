import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { ApprovalsService } from './approvals.service';
import { ApprovePaymentDto } from './dto/approve-payment.dto';
import { RejectPaymentDto } from './dto/reject-payment.dto';
import { SessionAuthGuard } from '../../common/guards/session-auth.guard';
import { PermissionsGuard } from '../../common/guards/permissions.guard';
import { RequirePermissions } from '../../common/decorators/require-permissions.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { AuthContext } from '../../common/types/auth-context';

/**
 * Routes nest under /payments (same resource PaymentsController exposes
 * /payments/:id/submit and /payments/:id/cancel from) because an approval
 * decision is an action on a specific payment, not a resource of its own
 * yet — but the controller lives in the Approvals module, since the
 * maker-checker and N-of-M logic behind these routes is approval-domain,
 * not payment-domain (see payment-state-machine.ts's Phase 8 scope note).
 */
@Controller('payments')
@UseGuards(SessionAuthGuard, PermissionsGuard)
export class ApprovalsController {
  constructor(private readonly approvalsService: ApprovalsService) {}

  @Get(':id/approvals')
  @RequirePermissions('payments.read')
  list(@CurrentUser() user: AuthContext, @Param('id') paymentId: string) {
    return this.approvalsService.listApprovals(user.organizationId, paymentId);
  }

  @Post(':id/approve')
  @RequirePermissions('payments.approve')
  approve(@CurrentUser() user: AuthContext, @Param('id') paymentId: string, @Body() dto: ApprovePaymentDto) {
    return this.approvalsService.approvePayment(user.organizationId, user.userId, paymentId, dto.reason);
  }

  @Post(':id/reject')
  @RequirePermissions('payments.approve')
  reject(@CurrentUser() user: AuthContext, @Param('id') paymentId: string, @Body() dto: RejectPaymentDto) {
    return this.approvalsService.rejectPayment(user.organizationId, user.userId, paymentId, dto.reason);
  }
}

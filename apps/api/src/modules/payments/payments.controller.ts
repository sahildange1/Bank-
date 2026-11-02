import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { PaymentsService } from './payments.service';
import { CreatePaymentDto } from './dto/create-payment.dto';
import { CancelPaymentDto } from './dto/cancel-payment.dto';
import { PaymentStatus } from './services/payment-state-machine';
import { SessionAuthGuard } from '../../common/guards/session-auth.guard';
import { PermissionsGuard } from '../../common/guards/permissions.guard';
import { RequirePermissions } from '../../common/decorators/require-permissions.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { AuthContext } from '../../common/types/auth-context';

@Controller('payments')
@UseGuards(SessionAuthGuard, PermissionsGuard)
export class PaymentsController {
  constructor(private readonly paymentsService: PaymentsService) {}

  @Get()
  @RequirePermissions('payments.read')
  list(@CurrentUser() user: AuthContext, @Query('status') status?: PaymentStatus) {
    return this.paymentsService.listPayments(user.organizationId, status);
  }

  @Get(':id')
  @RequirePermissions('payments.read')
  get(@CurrentUser() user: AuthContext, @Param('id') paymentId: string) {
    return this.paymentsService.getPayment(user.organizationId, paymentId);
  }

  @Get(':id/history')
  @RequirePermissions('payments.read')
  history(@CurrentUser() user: AuthContext, @Param('id') paymentId: string) {
    return this.paymentsService.getPaymentHistory(user.organizationId, paymentId);
  }

  @Post()
  @RequirePermissions('payments.create')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  create(@CurrentUser() user: AuthContext, @Body() dto: CreatePaymentDto) {
    return this.paymentsService.createPayment(user.organizationId, user.userId, dto);
  }

  @Post(':id/submit')
  @RequirePermissions('payments.create')
  submit(@CurrentUser() user: AuthContext, @Param('id') paymentId: string) {
    return this.paymentsService.submitPayment(user.organizationId, user.userId, paymentId);
  }

  @Post(':id/cancel')
  @RequirePermissions('payments.cancel')
  cancel(@CurrentUser() user: AuthContext, @Param('id') paymentId: string, @Body() dto: CancelPaymentDto) {
    return this.paymentsService.cancelPayment(user.organizationId, user.userId, paymentId, dto.reason);
  }
}

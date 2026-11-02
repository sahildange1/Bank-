import { Body, Controller, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { AccountsService } from './accounts.service';
import { CreateAccountDto } from './dto/create-account.dto';
import { CreateTransferDto } from './dto/create-transfer.dto';
import { SessionAuthGuard } from '../../common/guards/session-auth.guard';
import { PermissionsGuard } from '../../common/guards/permissions.guard';
import { RequirePermissions } from '../../common/decorators/require-permissions.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { AuthContext } from '../../common/types/auth-context';

@Controller('accounts')
@UseGuards(SessionAuthGuard, PermissionsGuard)
export class AccountsController {
  constructor(private readonly accountsService: AccountsService) {}

  @Get()
  @RequirePermissions('accounts.read')
  list(@CurrentUser() user: AuthContext) {
    return this.accountsService.listAccounts(user.organizationId);
  }

  @Post()
  @RequirePermissions('accounts.manage')
  create(@CurrentUser() user: AuthContext, @Body() dto: CreateAccountDto) {
    return this.accountsService.createAccount(user.organizationId, user.userId, dto);
  }

  @Get(':id')
  @RequirePermissions('accounts.read')
  get(@CurrentUser() user: AuthContext, @Param('id') accountId: string) {
    return this.accountsService.getAccount(user.organizationId, accountId);
  }

  @Get(':id/transactions')
  @RequirePermissions('accounts.read')
  transactions(@CurrentUser() user: AuthContext, @Param('id') accountId: string) {
    return this.accountsService.getAccountTransactions(user.organizationId, accountId);
  }

  @Patch(':id/freeze')
  @RequirePermissions('accounts.manage')
  freeze(@CurrentUser() user: AuthContext, @Param('id') accountId: string) {
    return this.accountsService.setAccountStatus(user.organizationId, user.userId, accountId, 'FROZEN');
  }

  @Patch(':id/unfreeze')
  @RequirePermissions('accounts.manage')
  unfreeze(@CurrentUser() user: AuthContext, @Param('id') accountId: string) {
    return this.accountsService.setAccountStatus(user.organizationId, user.userId, accountId, 'ACTIVE');
  }

  @Patch(':id/close')
  @RequirePermissions('accounts.manage')
  close(@CurrentUser() user: AuthContext, @Param('id') accountId: string) {
    return this.accountsService.setAccountStatus(user.organizationId, user.userId, accountId, 'CLOSED');
  }

  @Post('transfers')
  @RequirePermissions('accounts.manage')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  transfer(@CurrentUser() user: AuthContext, @Body() dto: CreateTransferDto) {
    return this.accountsService.createTransfer(user.organizationId, user.userId, dto);
  }
}

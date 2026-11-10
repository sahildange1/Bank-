import { Body, Controller, Get, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common';
import { AdminService } from './admin.service';
import { AuditService } from '../audit/services/audit.service';
import { ListOrganizationsDto } from './dto/list-organizations.dto';
import { OptionalReasonDto, RequiredReasonDto } from './dto/organization-action.dto';
import { QueryPlatformAuditDto } from './dto/query-platform-audit.dto';
import { PlatformOperatorGuard } from './guards/platform-operator.guard';
import { SessionAuthGuard } from '../../common/guards/session-auth.guard';
import { PermissionsGuard } from '../../common/guards/permissions.guard';
import { RequirePermissions } from '../../common/decorators/require-permissions.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { AuthContext } from '../../common/types/auth-context';

// Guard order matters: session -> platform-operator (org + MFA) -> permission.
@Controller('admin')
@UseGuards(SessionAuthGuard, PlatformOperatorGuard, PermissionsGuard)
export class AdminController {
  constructor(
    private readonly adminService: AdminService,
    private readonly auditService: AuditService,
  ) {}

  @Get('organizations')
  @RequirePermissions('platform.organizations.read')
  listOrganizations(@Query() query: ListOrganizationsDto) {
    return this.adminService.listOrganizations(query);
  }

  @Get('organizations/:id')
  @RequirePermissions('platform.organizations.read')
  getOrganization(@Param('id') id: string) {
    return this.adminService.getOrganization(id);
  }

  @Post('organizations/:id/approve')
  @HttpCode(200)
  @RequirePermissions('platform.organizations.manage')
  approve(@CurrentUser() user: AuthContext, @Param('id') id: string, @Body() dto: OptionalReasonDto) {
    return this.adminService.changeStatus(user.userId, user.organizationId, id, 'approve', dto.reason);
  }

  @Post('organizations/:id/suspend')
  @HttpCode(200)
  @RequirePermissions('platform.organizations.manage')
  suspend(@CurrentUser() user: AuthContext, @Param('id') id: string, @Body() dto: RequiredReasonDto) {
    return this.adminService.changeStatus(user.userId, user.organizationId, id, 'suspend', dto.reason);
  }

  @Post('organizations/:id/reactivate')
  @HttpCode(200)
  @RequirePermissions('platform.organizations.manage')
  reactivate(@CurrentUser() user: AuthContext, @Param('id') id: string, @Body() dto: OptionalReasonDto) {
    return this.adminService.changeStatus(user.userId, user.organizationId, id, 'reactivate', dto.reason);
  }

  @Post('organizations/:id/close')
  @HttpCode(200)
  @RequirePermissions('platform.organizations.manage')
  close(@CurrentUser() user: AuthContext, @Param('id') id: string, @Body() dto: RequiredReasonDto) {
    return this.adminService.changeStatus(user.userId, user.organizationId, id, 'close', dto.reason);
  }

  @Get('stats')
  @RequirePermissions('platform.stats.read')
  stats() {
    return this.adminService.getStats();
  }

  @Get('audit-events')
  @RequirePermissions('platform.audit.read')
  async auditEvents(@CurrentUser() user: AuthContext, @Query() query: QueryPlatformAuditDto) {
    const result = await this.auditService.queryEventsPlatform(query);
    // Reading across tenants is itself a privileged act: leave a trace.
    await this.auditService.record({
      organizationId: user.organizationId,
      actorId: user.userId,
      action: 'platform.audit.viewed',
      resourceType: 'AuditEvent',
      metadata: {
        filters: {
          organizationId: query.organizationId,
          actorId: query.actorId,
          action: query.action,
          resourceType: query.resourceType,
          resourceId: query.resourceId,
          dateFrom: query.dateFrom,
          dateTo: query.dateTo,
        },
      },
    });
    return result;
  }
}

import { Controller, Get, Query, Res, UseGuards } from '@nestjs/common';
import { Response } from 'express';
import { AuditService } from './services/audit.service';
import { auditEventsToCsv } from './services/audit-csv.util';
import { QueryAuditEventsDto } from './dto/query-audit-events.dto';
import { SessionAuthGuard } from '../../common/guards/session-auth.guard';
import { PermissionsGuard } from '../../common/guards/permissions.guard';
import { RequirePermissions } from '../../common/decorators/require-permissions.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { AuthContext } from '../../common/types/auth-context';

// architecture §5: `GET /audit-events — Query audit trail — audit.read`.
// No PUT/PATCH/DELETE route exists here, deliberately — see
// AuditService's own doc comment on why that's the append-only guarantee
// this phase can actually provide.
@Controller('audit-events')
@UseGuards(SessionAuthGuard, PermissionsGuard)
export class AuditController {
  constructor(private readonly auditService: AuditService) {}

  @Get()
  @RequirePermissions('audit.read')
  list(@CurrentUser() user: AuthContext, @Query() query: QueryAuditEventsDto) {
    return this.auditService.queryEvents(user.organizationId, query);
  }

  @Get('export')
  @RequirePermissions('audit.read')
  async export(@CurrentUser() user: AuthContext, @Query() query: QueryAuditEventsDto, @Res() res: Response) {
    const events = await this.auditService.queryEventsForExport(user.organizationId, query);
    const csv = auditEventsToCsv(events);
    res
      .status(200)
      .header('Content-Type', 'text/csv; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="audit-events-${Date.now()}.csv"`)
      .send(csv);
  }
}

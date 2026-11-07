import { Type } from 'class-transformer';
import { IsDateString, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

/**
 * Query params for GET /audit-events and GET /audit-events/export
 * (architecture §5: `GET /audit-events — Query audit trail — audit.read`).
 * All filters are optional and AND together; `organizationId` is never a
 * field here — it comes from the authenticated session via
 * TenantPrismaService.forOrg(), never from the client, same as every other
 * tenant-scoped query in this codebase.
 */
export class QueryAuditEventsDto {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  actorId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  action?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  resourceType?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  resourceId?: string;

  @IsOptional()
  @IsDateString()
  dateFrom?: string;

  @IsOptional()
  @IsDateString()
  dateTo?: string;

  // Cursor pagination (architecture §5 convention: `?cursor=&limit=`) — an
  // AuditEvent.id from a previous page's last row, per AuditService.queryEvents().
  @IsOptional()
  @IsString()
  @MaxLength(100)
  cursor?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;
}

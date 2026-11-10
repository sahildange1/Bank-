import { IsOptional, IsString, MaxLength } from 'class-validator';
import { QueryAuditEventsDto } from '../../audit/dto/query-audit-events.dto';

/**
 * Same filters as the per-organization audit query, plus an optional
 * organizationId. That filter exists ONLY here: the tenant-facing
 * QueryAuditEventsDto deliberately has no such field.
 */
export class QueryPlatformAuditDto extends QueryAuditEventsDto {
  @IsOptional() @IsString() @MaxLength(100) organizationId?: string;
}

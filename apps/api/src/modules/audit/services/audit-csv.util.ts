/**
 * Minimal CSV serialization for GET /audit-events/export — no new
 * dependency needed for a flat, fixed-column export like this one.
 * RFC 4180-style escaping: a field containing a comma, quote, or newline
 * is wrapped in quotes with internal quotes doubled.
 */
const COLUMNS = [
  'id',
  'createdAt',
  'organizationId',
  'actorId',
  'action',
  'resourceType',
  'resourceId',
  'ipAddress',
  'userAgent',
  'previousState',
  'newState',
  'metadata',
] as const;

function escapeCsvField(value: unknown): string {
  if (value === null || value === undefined) return '';
  const str = typeof value === 'string' ? value : JSON.stringify(value);
  if (/[",\n\r]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

export function auditEventsToCsv(
  events: Array<{
    id: string;
    createdAt: Date;
    organizationId: string | null;
    actorId: string | null;
    action: string;
    resourceType: string;
    resourceId: string | null;
    ipAddress: string | null;
    userAgent: string | null;
    previousState: unknown;
    newState: unknown;
    metadata: unknown;
  }>,
): string {
  const lines = [COLUMNS.join(',')];
  for (const event of events) {
    const row = [
      event.id,
      event.createdAt instanceof Date ? event.createdAt.toISOString() : String(event.createdAt),
      event.organizationId,
      event.actorId,
      event.action,
      event.resourceType,
      event.resourceId,
      event.ipAddress,
      event.userAgent,
      event.previousState,
      event.newState,
      event.metadata,
    ].map(escapeCsvField);
    lines.push(row.join(','));
  }
  // Trailing newline, conventional for CSV files.
  return lines.join('\r\n') + '\r\n';
}

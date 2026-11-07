import { auditEventsToCsv } from './audit-csv.util';

describe('auditEventsToCsv', () => {
  const BASE_EVENT = {
    id: 'evt-1',
    createdAt: new Date('2026-01-01T12:00:00.000Z'),
    organizationId: 'org-1',
    actorId: 'user-1',
    action: 'payment.created',
    resourceType: 'Payment',
    resourceId: 'pay-1',
    ipAddress: '127.0.0.1',
    userAgent: 'jest-agent',
    previousState: null,
    newState: { status: 'PENDING' },
    metadata: null,
  };

  it('emits a header row followed by one row per event, CRLF-terminated', () => {
    const csv = auditEventsToCsv([BASE_EVENT]);
    const lines = csv.split('\r\n');

    expect(lines[0]).toEqual(
      'id,createdAt,organizationId,actorId,action,resourceType,resourceId,ipAddress,userAgent,previousState,newState,metadata',
    );
    expect(lines[1]).toContain('evt-1');
    expect(lines[1]).toContain('2026-01-01T12:00:00.000Z');
    expect(csv.endsWith('\r\n')).toBe(true);
  });

  it('renders null/undefined fields as empty rather than the literal string "null"', () => {
    const csv = auditEventsToCsv([BASE_EVENT]);
    const dataLine = csv.split('\r\n')[1];
    const fields = dataLine.split(',');

    // previousState and metadata are null in BASE_EVENT.
    expect(fields).not.toContain('null');
  });

  it('quotes a field containing a comma and doubles embedded quotes (RFC 4180)', () => {
    const csv = auditEventsToCsv([
      { ...BASE_EVENT, userAgent: 'Mozilla/5.0, "special" build' },
    ]);
    const dataLine = csv.split('\r\n')[1];

    expect(dataLine).toContain('"Mozilla/5.0, ""special"" build"');
  });

  it('JSON-serializes object fields like newState rather than using [object Object]', () => {
    const csv = auditEventsToCsv([BASE_EVENT]);
    expect(csv).toContain(JSON.stringify(BASE_EVENT.newState).replace(/"/g, '""'));
  });

  it('returns just the header row (plus trailing CRLF) for an empty event list', () => {
    const csv = auditEventsToCsv([]);
    expect(csv.split('\r\n').filter(Boolean)).toHaveLength(1);
  });
});

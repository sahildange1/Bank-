import { ConflictException } from '@nestjs/common';
import { OrganizationStateMachine, OrgAction, OrgStatus } from './organization-state-machine';

describe('OrganizationStateMachine', () => {
  const sm = new OrganizationStateMachine();

  const VALID: Array<[OrgStatus, OrgAction, OrgStatus]> = [
    ['PENDING', 'approve', 'ACTIVE'],
    ['ACTIVE', 'suspend', 'SUSPENDED'],
    ['SUSPENDED', 'reactivate', 'ACTIVE'],
    ['PENDING', 'close', 'CLOSED'],
    ['ACTIVE', 'close', 'CLOSED'],
    ['SUSPENDED', 'close', 'CLOSED'],
  ];
  it.each(VALID)('%s --%s--> %s', (from, action, to) => {
    expect(sm.target(from, action)).toBe(to);
  });

  const ALL_STATUSES: OrgStatus[] = ['PENDING', 'ACTIVE', 'SUSPENDED', 'CLOSED'];
  const ACTIONS: OrgAction[] = ['approve', 'suspend', 'reactivate', 'close'];
  const validKeys = new Set(VALID.map(([f, a]) => `${f}:${a}`));
  const INVALID = ALL_STATUSES.flatMap((f) => ACTIONS.map((a) => [f, a] as const)).filter(
    ([f, a]) => !validKeys.has(`${f}:${a}`),
  );

  it.each(INVALID)('rejects %s --%s--> (409)', (from, action) => {
    expect(() => sm.target(from, action)).toThrow(ConflictException);
  });

  it('CLOSED is terminal: no action leaves it', () => {
    for (const a of ACTIONS) expect(() => sm.target('CLOSED', a)).toThrow(ConflictException);
  });
});

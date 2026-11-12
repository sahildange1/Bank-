import { permissionsMissing } from './role-grant.policy';

describe('permissionsMissing', () => {
  it('is empty when the actor holds everything needed', () => {
    expect(permissionsMissing(['a', 'b', 'c'], ['a', 'b'])).toEqual([]);
  });
  it('lists what the actor lacks (sorted, de-duplicated)', () => {
    expect(permissionsMissing(['users.manage'], ['z', 'users.manage', 'a', 'z'])).toEqual(['a', 'z']);
  });
  it('a users.manage-only actor cannot grant an admin role', () => {
    expect(permissionsMissing(['users.manage'], ['users.manage', 'payments.approve'])).toEqual(['payments.approve']);
  });
});

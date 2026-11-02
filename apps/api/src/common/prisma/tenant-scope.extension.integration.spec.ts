import { PrismaClient } from '@prisma/client';
import { withTenantScope, ForbiddenTenantAccessError } from './tenant-scope.extension';

/**
 * Requires a real, generated Prisma client against a live Postgres instance
 * — could not be executed in the sandbox this was authored in, because
 * Prisma's CLI/client needs a native engine binary from
 * binaries.prisma.sh, which that environment's network policy blocks (see
 * Phase 3/4 notes). Run with:
 *
 *   DATABASE_URL=postgresql://postgres:postgres@localhost:5432/corporate_banking \
 *   npx jest tenant-scope.extension.integration.spec.ts
 *
 * against the docker-compose Postgres, after `prisma generate` and
 * `prisma migrate deploy` have run with full network access.
 *
 * This is exactly the negative test flagged as missing when Phase 3 proved
 * (via raw SQL) that foreign keys alone don't stop payment.organizationId
 * = org2 from pointing at org1's account.
 */
describe('tenant-scope Prisma extension (integration)', () => {
  const prisma = new PrismaClient();
  let org1Id: string;
  let org2Id: string;
  let acct1Id: string;
  let ben1Id: string;

  beforeAll(async () => {
    const org1 = await prisma.organization.create({ data: { legalName: 'Acme Corp', status: 'ACTIVE' } });
    const org2 = await prisma.organization.create({ data: { legalName: 'Globex Inc', status: 'ACTIVE' } });
    org1Id = org1.id;
    org2Id = org2.id;

    const acct1 = await prisma.account.create({
      data: { organizationId: org1Id, accountNumber: 'ACC-TS-0001', currency: 'USD' },
    });
    acct1Id = acct1.id;

    const ben1 = await prisma.beneficiary.create({
      data: { organizationId: org1Id, name: 'Supplier Ltd', accountNumber: 'ACC-TS-0002' },
    });
    ben1Id = ben1.id;
  });

  afterAll(async () => {
    await prisma.beneficiary.deleteMany({ where: { organizationId: { in: [org1Id, org2Id] } } });
    await prisma.account.deleteMany({ where: { organizationId: { in: [org1Id, org2Id] } } });
    await prisma.organization.deleteMany({ where: { id: { in: [org1Id, org2Id] } } });
    await prisma.$disconnect();
  });

  it('cannot read another organization\'s account through the scoped client', async () => {
    const scopedAsOrg2 = withTenantScope(prisma, org2Id);
    const result = await scopedAsOrg2.account.findUnique({ where: { id: acct1Id } });
    expect(result).toBeNull(); // not "found but belongs to someone else" — just not found
  });

  it('cannot list another organization\'s accounts through findMany', async () => {
    const scopedAsOrg2 = withTenantScope(prisma, org2Id);
    const results = await scopedAsOrg2.account.findMany({});
    expect(results.find((a: { id: string }) => a.id === acct1Id)).toBeUndefined();
  });

  it('rejects creating a payment/account whose organizationId is spoofed to another org', async () => {
    const scopedAsOrg2 = withTenantScope(prisma, org2Id);
    await expect(
      scopedAsOrg2.account.create({
        data: { organizationId: org1Id, accountNumber: 'ACC-TS-SPOOF', currency: 'USD' } as any,
      }),
    ).rejects.toThrow(ForbiddenTenantAccessError);
  });

  it('rejects updating a row that does not belong to the caller\'s organization', async () => {
    const scopedAsOrg2 = withTenantScope(prisma, org2Id);
    await expect(
      scopedAsOrg2.account.update({ where: { id: acct1Id }, data: { status: 'FROZEN' } }),
    ).rejects.toThrow(ForbiddenTenantAccessError);
  });

  it('allows the owning organization full access to its own rows', async () => {
    const scopedAsOrg1 = withTenantScope(prisma, org1Id);
    const result = await scopedAsOrg1.account.findUnique({ where: { id: acct1Id } });
    expect(result?.id).toEqual(acct1Id);

    const updated = await scopedAsOrg1.account.update({ where: { id: acct1Id }, data: { status: 'FROZEN' } });
    expect(updated.status).toEqual('FROZEN');
  });

  it('reproduces the Phase 3 gap being closed: the same cross-org write that raw SQL allowed is now blocked', async () => {
    const scopedAsOrg2 = withTenantScope(prisma, org2Id);
    // This mirrors exactly what Phase 3's raw psql smoke test successfully
    // (and problematically) inserted: an org2-scoped write referencing
    // org1's beneficiary/account.
    await expect(
      scopedAsOrg2.beneficiary.update({ where: { id: ben1Id }, data: { active: false } }),
    ).rejects.toThrow(ForbiddenTenantAccessError);
  });
});

import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { TenantPrismaService } from '../../common/prisma/tenant-prisma.service';
import { AuditService } from '../audit/services/audit.service';
import { BeneficiariesService } from './beneficiaries.service';

/**
 * Same limitation as the other *.integration.spec.ts files in this repo
 * (binaries.prisma.sh is blocked in this sandbox — see Phase 3/4/6 notes).
 * The maker-checker self-approval rule, cooling-off window, and masking fix
 * are already covered for real by beneficiaries.service.spec.ts (mocked
 * Prisma, runs in this sandbox). This file instead exercises what only a
 * real database can verify: that the Phase 7 migration's FK constraints
 * and the tenant-scope extension interact correctly with the new
 * createdByUserId/verifiedByUserId columns, and the full create -> verify
 * -> disable -> re-enable lifecycle against real Postgres.
 *
 *   DATABASE_URL=postgresql://postgres:postgres@localhost:5432/corporate_banking \
 *   npx jest --config jest.integration.config.js beneficiaries.integration
 */
describe('BeneficiariesService (integration)', () => {
  let prisma: PrismaClient;
  let service: BeneficiariesService;
  let orgId: string;
  let makerId: string;
  let approverId: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [PrismaService, TenantPrismaService, AuditService, BeneficiariesService],
    }).compile();

    prisma = moduleRef.get(PrismaService);
    service = moduleRef.get(BeneficiariesService);

    const org = await prisma.organization.create({ data: { legalName: 'Beneficiary Test Co', status: 'ACTIVE' } });
    orgId = org.id;
    const maker = await prisma.user.create({
      data: { organizationId: orgId, email: 'maker@benitest.test', passwordHash: 'x', status: 'ACTIVE' },
    });
    const approver = await prisma.user.create({
      data: { organizationId: orgId, email: 'approver@benitest.test', passwordHash: 'x', status: 'ACTIVE' },
    });
    makerId = maker.id;
    approverId = approver.id;
  });

  afterAll(async () => {
    await prisma.beneficiary.deleteMany({ where: { organizationId: orgId } });
    await prisma.user.deleteMany({ where: { organizationId: orgId } });
    await prisma.organization.delete({ where: { id: orgId } });
    await prisma.$disconnect();
  });

  it('full lifecycle: create -> blocked self-verify -> verify by another user -> disable -> re-enable resets to PENDING', async () => {
    const created = await service.createBeneficiary(orgId, makerId, {
      name: 'Acme Supplier',
      accountNumber: '9876543210',
    });
    expect(created.verificationStatus).toEqual('PENDING');

    await expect(service.verifyBeneficiary(orgId, makerId, created.id)).rejects.toThrow();

    const verified = await service.verifyBeneficiary(orgId, approverId, created.id);
    expect(verified.verificationStatus).toEqual('VERIFIED');

    // FK correctness: verifiedByUserId actually persisted and points at approverId.
    const row = await prisma.beneficiary.findUnique({ where: { id: created.id } });
    expect(row?.verifiedByUserId).toEqual(approverId);
    expect(row?.createdByUserId).toEqual(makerId);

    const disabled = await service.disableBeneficiary(orgId, makerId, created.id);
    expect(disabled.active).toBe(false);

    const reEnabled = await service.enableBeneficiary(orgId, approverId, created.id);
    expect(reEnabled.active).toBe(true);
    expect(reEnabled.verificationStatus).toEqual('PENDING'); // re-enabling resets verification
  });

  it('editing the account number forces re-verification', async () => {
    const created = await service.createBeneficiary(orgId, makerId, {
      name: 'Globex Supplier',
      accountNumber: '1111111111',
    });
    await service.verifyBeneficiary(orgId, approverId, created.id);

    const updated = await service.updateBeneficiary(orgId, makerId, created.id, {
      accountNumber: '2222222222',
    });
    expect(updated.verificationStatus).toEqual('PENDING');
  });

  it('a user from a different organization cannot see or act on this organization\'s beneficiary', async () => {
    const created = await service.createBeneficiary(orgId, makerId, {
      name: 'Initech Supplier',
      accountNumber: '3333333333',
    });

    const otherOrg = await prisma.organization.create({ data: { legalName: 'Other Org', status: 'ACTIVE' } });
    await expect(service.getBeneficiary(otherOrg.id, created.id, ['beneficiaries.approve'])).rejects.toThrow();
    await prisma.organization.delete({ where: { id: otherOrg.id } });
  });
});

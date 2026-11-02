import { ForbiddenException, BadRequestException } from '@nestjs/common';
import { BeneficiariesService, BENEFICIARY_COOLING_OFF_MS } from './beneficiaries.service';

/**
 * Unlike the *.integration.spec.ts files elsewhere in this repo, this suite
 * does NOT need a real Prisma client or a live database — TenantPrismaService
 * and AuditService are mocked, so it runs for real in this sandbox despite
 * the binaries.prisma.sh block (see Phase 3/4/6 notes). It exercises the
 * maker-checker self-approval rule, the cooling-off window, and the account
 * number masking fix made during Phase 7 review.
 */
describe('BeneficiariesService (unit, mocked Prisma)', () => {
  const ORG_ID = 'org-1';
  const MAKER_ID = 'user-maker';
  const APPROVER_ID = 'user-approver';

  function makeService() {
    const scopedClient = {
      beneficiary: {
        create: jest.fn(),
        findMany: jest.fn(),
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const tenantPrisma = { forOrg: jest.fn().mockReturnValue(scopedClient) };
    const auditService = { record: jest.fn().mockResolvedValue(undefined) };
    const service = new BeneficiariesService(tenantPrisma as any, auditService as any);
    return { service, scopedClient, auditService };
  }

  describe('maker-checker self-approval rule', () => {
    it('blocks the creator from verifying their own beneficiary', async () => {
      const { service, scopedClient, auditService } = makeService();
      scopedClient.beneficiary.findUnique.mockResolvedValue({
        id: 'ben-1',
        createdByUserId: MAKER_ID,
        verificationStatus: 'PENDING',
        active: true,
      });

      await expect(service.verifyBeneficiary(ORG_ID, MAKER_ID, 'ben-1')).rejects.toThrow(ForbiddenException);
      expect(scopedClient.beneficiary.update).not.toHaveBeenCalled();
      expect(auditService.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'beneficiary.verify_blocked_self_approval' }),
      );
    });

    it('allows a different user to verify the beneficiary', async () => {
      const { service, scopedClient } = makeService();
      scopedClient.beneficiary.findUnique.mockResolvedValue({
        id: 'ben-1',
        createdByUserId: MAKER_ID,
        verificationStatus: 'PENDING',
        active: true,
      });
      scopedClient.beneficiary.update.mockResolvedValue({
        id: 'ben-1',
        name: 'Supplier',
        accountNumber: '1234567890',
        bankIdentifier: null,
        verificationStatus: 'VERIFIED',
        active: true,
        verifiedAt: new Date(),
        rejectionReason: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      await expect(service.verifyBeneficiary(ORG_ID, APPROVER_ID, 'ben-1')).resolves.toBeDefined();
      expect(scopedClient.beneficiary.update).toHaveBeenCalled();
    });

    it('blocks the creator from rejecting their own beneficiary and audits the attempt', async () => {
      const { service, scopedClient, auditService } = makeService();
      scopedClient.beneficiary.findUnique.mockResolvedValue({
        id: 'ben-1',
        createdByUserId: MAKER_ID,
        verificationStatus: 'PENDING',
        active: true,
      });

      await expect(
        service.rejectBeneficiary(ORG_ID, MAKER_ID, 'ben-1', { reason: 'suspicious' }),
      ).rejects.toThrow(ForbiddenException);
      expect(auditService.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'beneficiary.reject_blocked_self_approval' }),
      );
    });

    it('rejects re-verifying an already-verified beneficiary', async () => {
      const { service, scopedClient } = makeService();
      scopedClient.beneficiary.findUnique.mockResolvedValue({
        id: 'ben-1',
        createdByUserId: MAKER_ID,
        verificationStatus: 'VERIFIED',
        active: true,
      });

      await expect(service.verifyBeneficiary(ORG_ID, APPROVER_ID, 'ben-1')).rejects.toThrow(BadRequestException);
    });
  });

  describe('cooling-off period (isEligibleForPayments)', () => {
    const { service } = makeService();

    it('is not eligible immediately after verification', () => {
      const eligible = service.isEligibleForPayments({
        active: true,
        verificationStatus: 'VERIFIED',
        verifiedAt: new Date(), // just now
      });
      expect(eligible).toBe(false);
    });

    it('becomes eligible once the cooling-off window has passed', () => {
      const eligible = service.isEligibleForPayments({
        active: true,
        verificationStatus: 'VERIFIED',
        verifiedAt: new Date(Date.now() - BENEFICIARY_COOLING_OFF_MS - 1000),
      });
      expect(eligible).toBe(true);
    });

    it('is never eligible if not VERIFIED, regardless of timing', () => {
      const eligible = service.isEligibleForPayments({
        active: true,
        verificationStatus: 'PENDING',
        verifiedAt: new Date(Date.now() - BENEFICIARY_COOLING_OFF_MS - 1000),
      });
      expect(eligible).toBe(false);
    });

    it('is never eligible if disabled, even if verified and past cooling-off', () => {
      const eligible = service.isEligibleForPayments({
        active: false,
        verificationStatus: 'VERIFIED',
        verifiedAt: new Date(Date.now() - BENEFICIARY_COOLING_OFF_MS - 1000),
      });
      expect(eligible).toBe(false);
    });
  });

  describe('account number masking (present())', () => {
    // present()/maskAccountNumber are private; exercised indirectly through
    // listBeneficiaries, which is how the masking bug found in Phase 7
    // review was actually reachable from the API.
    it('fully masks an account number at the DTO minimum length (4 chars) for an unprivileged caller', async () => {
      const { service, scopedClient } = makeService();
      scopedClient.beneficiary.findMany.mockResolvedValue([
        {
          id: 'ben-1',
          name: 'Supplier',
          accountNumber: '1234',
          bankIdentifier: null,
          verificationStatus: 'VERIFIED',
          active: true,
          createdByUserId: MAKER_ID,
          verifiedAt: new Date(Date.now() - BENEFICIARY_COOLING_OFF_MS - 1000),
          verifiedByUserId: APPROVER_ID,
          rejectionReason: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ]);

      const [result] = await service.listBeneficiaries(ORG_ID, [] /* no beneficiaries.* permissions */);
      expect(result.accountNumber).not.toContain('1234');
      expect(result.accountNumber).toEqual('••••');
    });

    it('shows the unmasked account number for a caller with beneficiaries.approve', async () => {
      const { service, scopedClient } = makeService();
      scopedClient.beneficiary.findMany.mockResolvedValue([
        {
          id: 'ben-1',
          name: 'Supplier',
          accountNumber: '1234567890',
          bankIdentifier: null,
          verificationStatus: 'VERIFIED',
          active: true,
          createdByUserId: MAKER_ID,
          verifiedAt: new Date(),
          verifiedByUserId: APPROVER_ID,
          rejectionReason: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ]);

      const [result] = await service.listBeneficiaries(ORG_ID, ['beneficiaries.approve']);
      expect(result.accountNumber).toEqual('1234567890');
    });
  });
});

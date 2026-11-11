import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { TenantPrismaService } from '../../common/prisma/tenant-prisma.service';
import { AuditService } from '../audit/services/audit.service';
import { CreateBeneficiaryDto } from './dto/create-beneficiary.dto';
import { UpdateBeneficiaryDto } from './dto/update-beneficiary.dto';
import { RejectBeneficiaryDto } from './dto/reject-beneficiary.dto';

/**
 * How long a beneficiary must stay VERIFIED before it can be used as a
 * payment destination — the "cooling-off period" called for in the brief
 * (§11). Phase 8 (Payments) is responsible for actually enforcing this at
 * payment-creation time; `isEligibleForPayments()` below is the function it
 * should call. Not configurable per-organization yet — see the Phase 7
 * write-up for why that's flagged as an open question rather than built now.
 */
export const BENEFICIARY_COOLING_OFF_MS = 60 * 60 * 1000; // 1 hour

interface BeneficiaryRecord {
  id: string;
  name: string;
  accountNumber: string;
  bankIdentifier: string | null;
  verificationStatus: 'PENDING' | 'VERIFIED' | 'REJECTED';
  active: boolean;
  createdByUserId: string | null;
  verifiedAt: Date | null;
  verifiedByUserId: string | null;
  rejectionReason: string | null;
  createdAt: Date;
  updatedAt: Date;
}

@Injectable()
export class BeneficiariesService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly auditService: AuditService,
  ) {}

  async createBeneficiary(organizationId: string, actorUserId: string, dto: CreateBeneficiaryDto) {
    const scoped = this.tenantPrisma.forOrg(organizationId);

    const beneficiary = await scoped.beneficiary.create({
      data: {
        organizationId, // also injected/verified by the tenant extension
        name: dto.name,
        accountNumber: dto.accountNumber,
        bankIdentifier: dto.bankIdentifier,
        verificationStatus: 'PENDING',
        active: true,
        createdByUserId: actorUserId,
      },
    });

    await this.auditService.record({
      organizationId,
      actorId: actorUserId,
      action: 'beneficiary.created',
      resourceType: 'Beneficiary',
      resourceId: beneficiary.id,
      newState: this.redactForAudit(beneficiary),
    });

    return this.present(beneficiary, true);
  }

  async listBeneficiaries(organizationId: string, callerPermissions: string[]) {
    const scoped = this.tenantPrisma.forOrg(organizationId);
    const beneficiaries = await scoped.beneficiary.findMany({ orderBy: { createdAt: 'desc' } });
    const canSeeFull = this.canSeeUnmasked(callerPermissions);
    return beneficiaries.map((b: BeneficiaryRecord) => this.present(b, canSeeFull));
  }

  async getBeneficiary(organizationId: string, beneficiaryId: string, callerPermissions: string[]) {
    const scoped = this.tenantPrisma.forOrg(organizationId);
    const beneficiary = await scoped.beneficiary.findUnique({ where: { id: beneficiaryId } });
    if (!beneficiary) throw new NotFoundException();
    return this.present(beneficiary, this.canSeeUnmasked(callerPermissions));
  }

  /**
   * Editing accountNumber or bankIdentifier is treated as changing *what*
   * is being vouched for, so it forces re-verification (back to PENDING,
   * clears verifiedAt/verifiedByUserId) — the same reasoning as the
   * cooling-off period itself: a changed destination is a new risk, not a
   * continuation of the old one. Editing only the display name does not.
   */
  async updateBeneficiary(
    organizationId: string,
    actorUserId: string,
    beneficiaryId: string,
    dto: UpdateBeneficiaryDto,
  ) {
    const scoped = this.tenantPrisma.forOrg(organizationId);
    const existing = await scoped.beneficiary.findUnique({ where: { id: beneficiaryId } });
    if (!existing) throw new NotFoundException();
    if (!existing.active) {
      throw new BadRequestException('Cannot edit a disabled beneficiary. Re-enable it first.');
    }

    const sensitiveFieldsChanged =
      (dto.accountNumber !== undefined && dto.accountNumber !== existing.accountNumber) ||
      (dto.bankIdentifier !== undefined && dto.bankIdentifier !== existing.bankIdentifier);

    const updated = await scoped.beneficiary.update({
      where: { id: beneficiaryId },
      data: {
        name: dto.name ?? undefined,
        accountNumber: dto.accountNumber ?? undefined,
        bankIdentifier: dto.bankIdentifier ?? undefined,
        ...(sensitiveFieldsChanged
          ? { verificationStatus: 'PENDING', verifiedAt: null, verifiedByUserId: null, rejectionReason: null }
          : {}),
      },
    });

    await this.auditService.record({
      organizationId,
      actorId: actorUserId,
      action: sensitiveFieldsChanged ? 'beneficiary.updated_requires_reverification' : 'beneficiary.updated',
      resourceType: 'Beneficiary',
      resourceId: beneficiaryId,
      previousState: this.redactForAudit(existing),
      newState: this.redactForAudit(updated),
    });

    return this.present(updated, true);
  }

  /**
   * Maker-checker for beneficiaries, unconditionally — unlike payments
   * (schema: ApprovalPolicy.makerCanApproveOwn), there's no per-org
   * configuration knob for this yet. Flagged as an open question in the
   * Phase 7 write-up: worth deciding whether beneficiaries need the same
   * configurable policy model payments have, or whether a fixed rule is
   * fine given beneficiaries are lower-stakes than an actual money
   * movement.
   */
  async verifyBeneficiary(organizationId: string, actorUserId: string, beneficiaryId: string) {
    const scoped = this.tenantPrisma.forOrg(organizationId);
    const existing = await scoped.beneficiary.findUnique({ where: { id: beneficiaryId } });
    if (!existing) throw new NotFoundException();

    if (existing.createdByUserId === actorUserId) {
      await this.auditService.record({
        organizationId,
        actorId: actorUserId,
        action: 'beneficiary.verify_blocked_self_approval',
        resourceType: 'Beneficiary',
        resourceId: beneficiaryId,
      });
      throw new ForbiddenException('You cannot verify a beneficiary you created yourself.');
    }

    if (existing.verificationStatus === 'VERIFIED') {
      throw new BadRequestException('Beneficiary is already verified.');
    }
    if (!existing.active) {
      throw new BadRequestException('Cannot verify a disabled beneficiary.');
    }

    const updated = await scoped.beneficiary.update({
      where: { id: beneficiaryId },
      data: {
        verificationStatus: 'VERIFIED',
        verifiedAt: new Date(),
        verifiedByUserId: actorUserId,
        rejectionReason: null,
      },
    });

    await this.auditService.record({
      organizationId,
      actorId: actorUserId,
      action: 'beneficiary.verified',
      resourceType: 'Beneficiary',
      resourceId: beneficiaryId,
      previousState: { verificationStatus: existing.verificationStatus },
      newState: { verificationStatus: 'VERIFIED' },
    });

    return this.present(updated, true);
  }

  async rejectBeneficiary(organizationId: string, actorUserId: string, beneficiaryId: string, dto: RejectBeneficiaryDto) {
    const scoped = this.tenantPrisma.forOrg(organizationId);
    const existing = await scoped.beneficiary.findUnique({ where: { id: beneficiaryId } });
    if (!existing) throw new NotFoundException();

    if (existing.createdByUserId === actorUserId) {
      // Audited for the same reason as the blocked self-approval case in
      // verifyBeneficiary: a blocked maker-checker violation attempt is
      // itself security-relevant and worth a record, not just a 403.
      // (Inconsistent with verifyBeneficiary's handling of this same case
      // when reviewed in Phase 7 — made consistent here.)
      await this.auditService.record({
        organizationId,
        actorId: actorUserId,
        action: 'beneficiary.reject_blocked_self_approval',
        resourceType: 'Beneficiary',
        resourceId: beneficiaryId,
      });
      throw new ForbiddenException('You cannot reject a beneficiary you created yourself.');
    }
    if (existing.verificationStatus === 'VERIFIED') {
      throw new BadRequestException('Cannot reject an already-verified beneficiary. Disable it instead.');
    }

    const updated = await scoped.beneficiary.update({
      where: { id: beneficiaryId },
      data: { verificationStatus: 'REJECTED', rejectionReason: dto.reason, verifiedAt: null, verifiedByUserId: null },
    });

    await this.auditService.record({
      organizationId,
      actorId: actorUserId,
      action: 'beneficiary.rejected',
      resourceType: 'Beneficiary',
      resourceId: beneficiaryId,
      previousState: { verificationStatus: existing.verificationStatus },
      newState: { verificationStatus: 'REJECTED', reason: dto.reason },
    });

    return this.present(updated, true);
  }

  /**
   * Disabling is a risk-reducing action (removes a payment destination),
   * so it's gated at the lower `beneficiaries.create` bar rather than
   * requiring `beneficiaries.approve` — see the controller's permission
   * decorator and the Phase 7 write-up for the reasoning.
   */
  async disableBeneficiary(organizationId: string, actorUserId: string, beneficiaryId: string) {
    const scoped = this.tenantPrisma.forOrg(organizationId);
    const existing = await scoped.beneficiary.findUnique({ where: { id: beneficiaryId } });
    if (!existing) throw new NotFoundException();

    const updated = await scoped.beneficiary.update({ where: { id: beneficiaryId }, data: { active: false } });

    await this.auditService.record({
      organizationId,
      actorId: actorUserId,
      action: 'beneficiary.disabled',
      resourceType: 'Beneficiary',
      resourceId: beneficiaryId,
    });

    return this.present(updated, true);
  }

  /**
   * Re-enabling is risk-ADDING (restores a payment destination), so unlike
   * disable it requires `beneficiaries.approve` and resets verification —
   * a previously-disabled beneficiary must clear the same bar a brand new
   * one would, including the maker-checker/cooling-off rules.
   */
  async enableBeneficiary(organizationId: string, actorUserId: string, beneficiaryId: string) {
    const scoped = this.tenantPrisma.forOrg(organizationId);
    const existing = await scoped.beneficiary.findUnique({ where: { id: beneficiaryId } });
    if (!existing) throw new NotFoundException();
    if (existing.active) {
      throw new BadRequestException('Beneficiary is already active.');
    }

    const updated = await scoped.beneficiary.update({
      where: { id: beneficiaryId },
      data: { active: true, verificationStatus: 'PENDING', verifiedAt: null, verifiedByUserId: null, rejectionReason: null },
    });

    await this.auditService.record({
      organizationId,
      actorId: actorUserId,
      action: 'beneficiary.enabled_pending_reverification',
      resourceType: 'Beneficiary',
      resourceId: beneficiaryId,
    });

    return this.present(updated, true);
  }

  /** Called by Phase 8 (Payments) before allowing a beneficiary as a payment destination. */
  isEligibleForPayments(beneficiary: Pick<BeneficiaryRecord, 'active' | 'verificationStatus' | 'verifiedAt'>): boolean {
    if (!beneficiary.active || beneficiary.verificationStatus !== 'VERIFIED' || !beneficiary.verifiedAt) {
      return false;
    }
    return Date.now() - beneficiary.verifiedAt.getTime() >= BENEFICIARY_COOLING_OFF_MS;
  }

  private canSeeUnmasked(permissions: string[]): boolean {
    return permissions.includes('beneficiaries.create') || permissions.includes('beneficiaries.approve');
  }

  /** Masks all but the last 4 characters of the account number for callers without beneficiaries.create/approve — architecture §11, "never expose sensitive beneficiary information unnecessarily." */
  private present(beneficiary: BeneficiaryRecord, unmasked: boolean) {
    const accountNumber = unmasked
      ? beneficiary.accountNumber
      : this.maskAccountNumber(beneficiary.accountNumber);
    return {
      id: beneficiary.id,
      name: beneficiary.name,
      accountNumber,
      bankIdentifier: unmasked ? beneficiary.bankIdentifier : null,
      verificationStatus: beneficiary.verificationStatus,
      active: beneficiary.active,
      verifiedAt: beneficiary.verifiedAt,
      rejectionReason: beneficiary.rejectionReason,
      eligibleForPayments: this.isEligibleForPayments(beneficiary),
      createdAt: beneficiary.createdAt,
      updatedAt: beneficiary.updatedAt,
    };
  }

  /**
   * Masks all but the last 4 characters — except when the whole number is 4
   * characters or fewer (the DTO's minimum length), in which case there's
   * nothing left to mask after showing 4 digits, so the entire value is
   * hidden instead. The original version of this method always revealed
   * the last 4 characters regardless of total length, which fully exposed
   * any account number at the DTO's minimum length (e.g. "1234" masked to
   * "••••1234" — the bullets added nothing). Caught and fixed during
   * Phase 7 review.
   */
  private maskAccountNumber(accountNumber: string): string {
    if (accountNumber.length <= 4) {
      return '•'.repeat(accountNumber.length);
    }
    const visible = accountNumber.slice(-4);
    return `${'•'.repeat(accountNumber.length - 4)}${visible}`;
  }

  /** Audit log never stores the raw account number unredacted beyond what's needed — same masking applied to audit metadata as to API responses. */
  private redactForAudit(beneficiary: BeneficiaryRecord) {
    return {
      name: beneficiary.name,
      accountNumber: this.maskAccountNumber(beneficiary.accountNumber),
      verificationStatus: beneficiary.verificationStatus,
      active: beneficiary.active,
    };
  }
}

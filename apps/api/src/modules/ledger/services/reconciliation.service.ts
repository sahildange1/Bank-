import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { TenantPrismaService } from '../../../common/prisma/tenant-prisma.service';
import { AuditService } from '../../audit/services/audit.service';

export interface AccountReconciliationResult {
  accountId: string;
  accountNumber: string;
  cachedBalanceMinorUnits: string;
  computedBalanceMinorUnits: string;
  driftMinorUnits: string;
  inSync: boolean;
}

export interface ReconciliationReport {
  organizationId: string;
  accountsChecked: number;
  accountsWithDrift: number;
  results: AccountReconciliationResult[];
  ranAt: string;
}

/**
 * Phase 10 scope (per LedgerModule's own doc comment, carried since
 * Phase 6): the nightly/on-demand drift-check job and reconciliation
 * reporting, nothing else. Architecture §9: "Account.balanceMinorUnits is
 * a cache, refreshed inside the same transaction as the ledger post...
 * drift should be impossible if writes only ever go through the ledger
 * service, but the job exists to catch bugs early."
 *
 * Deliberately detect-and-report, never auto-correct: if `computeBalance`
 * disagreed with the cache because of a bug in *this* service rather than
 * in LedgerService, silently overwriting the cache with a wrong computed
 * value would be worse than leaving a visible, audited drift for a human
 * to investigate (brief's own rule: never make financial state changes
 * without validation, and an unreviewed auto-correction is exactly that).
 */
@Injectable()
export class ReconciliationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantPrisma: TenantPrismaService,
    private readonly auditService: AuditService,
  ) {}

  /**
   * On-demand reconciliation for one organization — what the architecture
   * doc calls the "on-demand reconciliation job" (§9), callable from the
   * API. The equivalent *nightly* run is `reconcileAllOrganizations()`
   * below; actually scheduling it (a cron/BullMQ repeatable job) is not
   * built yet — see the Phase 10 write-up's open-items list.
   */
  async reconcileOrganization(organizationId: string, actorUserId?: string): Promise<ReconciliationReport> {
    const scoped = this.tenantPrisma.forOrg(organizationId);
    const accounts = await scoped.account.findMany({});

    const results: AccountReconciliationResult[] = [];
    for (const account of accounts) {
      const computed = await this.computeBalanceFromLedger(account.id);
      const drift = computed - account.balanceMinorUnits;
      const inSync = drift === 0n;

      results.push({
        accountId: account.id,
        accountNumber: account.accountNumber,
        cachedBalanceMinorUnits: account.balanceMinorUnits.toString(),
        computedBalanceMinorUnits: computed.toString(),
        driftMinorUnits: drift.toString(),
        inSync,
      });

      if (!inSync) {
        await this.auditService.record({
          organizationId,
          actorId: actorUserId ?? null,
          action: 'reconciliation.drift_detected',
          resourceType: 'Account',
          resourceId: account.id,
          previousState: { cachedBalanceMinorUnits: account.balanceMinorUnits.toString() },
          newState: { computedBalanceMinorUnits: computed.toString() },
          metadata: { driftMinorUnits: drift.toString() },
        });
      }
    }

    const accountsWithDrift = results.filter((r) => !r.inSync).length;

    await this.auditService.record({
      organizationId,
      actorId: actorUserId ?? null,
      action: 'reconciliation.completed',
      resourceType: 'Organization',
      resourceId: organizationId,
      metadata: { accountsChecked: results.length, accountsWithDrift },
    });

    return {
      organizationId,
      accountsChecked: results.length,
      accountsWithDrift,
      results,
      ranAt: new Date().toISOString(),
    };
  }

  /**
   * Cross-tenant by design — the nightly sweep this is meant to back has
   * no single organizationId to scope by, the same reasoning
   * TenantPrismaService.raw()'s doc comment already gives for background
   * workers. Not wired to an actual scheduler yet (no cron/BullMQ
   * repeatable-job infra exists in this codebase) — see the Phase 10
   * write-up.
   */
  async reconcileAllOrganizations(): Promise<ReconciliationReport[]> {
    const organizations = await this.prisma.organization.findMany({ select: { id: true } });
    const reports: ReconciliationReport[] = [];
    for (const org of organizations) {
      reports.push(await this.reconcileOrganization(org.id));
    }
    return reports;
  }

  /**
   * SUM(LedgerEntry), the one source of truth per architecture §9 — never
   * Account.balanceMinorUnits, which is only ever the cache being checked.
   */
  private async computeBalanceFromLedger(accountId: string): Promise<bigint> {
    const rows = await this.prisma.$queryRaw<Array<{ direction: 'DEBIT' | 'CREDIT'; total: bigint }>>`
      SELECT direction, SUM("amountMinorUnits")::bigint AS total
      FROM ledger_entries
      WHERE "accountId" = ${accountId}
      GROUP BY direction
    `;

    let credit = 0n;
    let debit = 0n;
    for (const row of rows) {
      if (row.direction === 'CREDIT') credit = row.total;
      else if (row.direction === 'DEBIT') debit = row.total;
    }
    return credit - debit;
  }
}

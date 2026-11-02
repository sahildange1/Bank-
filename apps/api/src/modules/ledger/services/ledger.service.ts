import { ConflictException, Injectable, UnprocessableEntityException } from '@nestjs/common';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { AuditService } from '../../audit/services/audit.service';

export interface LedgerEntryInput {
  accountId: string;
  direction: 'DEBIT' | 'CREDIT';
  amountMinorUnits: bigint;
  currency: string;
}

export interface PostDoubleEntryInput {
  organizationId: string;
  actorUserId: string;
  description: string;
  idempotencyKey: string;
  paymentId?: string;
  entries: LedgerEntryInput[];
}

export interface PostDoubleEntryResult {
  groupId: string;
  alreadyPosted: boolean;
}

/**
 * Deliberate scope note, same shape as AuditService in Phase 4: the full
 * "Ledger and reconciliation" phase (Phase 10) covers the nightly
 * reconciliation job and drift alerting. But architecture §9/§10 require
 * that balance-affecting writes ONLY ever happen through one code path, and
 * that path is needed starting now for internal transfers (Phase 6) — it
 * can't wait for Phase 10. This is that one path. Phase 8/9 (Payments,
 * Approvals) will call this same method once a payment reaches APPROVED;
 * nothing else in the codebase should write to Account.balanceMinorUnits
 * or LedgerEntry directly.
 */
@Injectable()
export class LedgerService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
  ) {}

  /**
   * Posts a balanced double-entry group atomically: validates the entries
   * net to zero per currency, locks every affected account row (in a
   * stable order, to avoid deadlocking against a concurrent transfer
   * touching the same two accounts in the opposite order), verifies no
   * DEBIT would overdraw its account, writes the LedgerEntryGroup +
   * LedgerEntry rows, updates each account's cached balance, and records
   * an audit event — all in one DB transaction.
   *
   * Idempotent: calling again with the same idempotencyKey returns the
   * existing group rather than posting twice.
   */
  async postDoubleEntry(input: PostDoubleEntryInput): Promise<PostDoubleEntryResult> {
    this.validateEntriesBalance(input.entries);

    const existing = await this.prisma.ledgerEntryGroup.findUnique({
      where: { idempotencyKey: input.idempotencyKey },
    });
    if (existing) {
      return { groupId: existing.id, alreadyPosted: true };
    }

    const accountIds = [...new Set(input.entries.map((e) => e.accountId))].sort(); // stable order -> no lock-order deadlocks

    // Typed as `any` to work around Prisma's engine-less fallback type stub
    // in this sandbox (see Phase 3/4 notes — binaries.prisma.sh is blocked
    // here, so `prisma generate` never produces real TransactionClient
    // types). Once a real client is generated elsewhere, `tx` resolves to
    // the proper Prisma.TransactionClient and nothing here needs to change.
    const groupId = await this.prisma.$transaction(async (tx: any) => {
      // Lock every affected account row before reading any balance, so two
      // concurrent transfers touching the same account can't both read a
      // stale balance and both pass the sufficient-funds check (the race
      // condition flagged in the Phase 1 threat model).
      const lockedAccounts = new Map<
        string,
        { id: string; organizationId: string; balanceMinorUnits: bigint; status: string }
      >();
      for (const accountId of accountIds) {
        const rows = await tx.$queryRaw<
          Array<{ id: string; organizationId: string; balanceMinorUnits: bigint; status: string }>
        >`SELECT id, "organizationId", "balanceMinorUnits", status FROM accounts WHERE id = ${accountId} FOR UPDATE`;
        const row = rows[0];
        if (!row) {
          throw new UnprocessableEntityException(`Account ${accountId} not found`);
        }
        if (row.organizationId !== input.organizationId) {
          // Mirrors the tenant-scope extension's behaviour: don't confirm
          // existence of another org's account, just fail the operation.
          throw new UnprocessableEntityException(`Account ${accountId} not found`);
        }
        if (row.status !== 'ACTIVE') {
          throw new UnprocessableEntityException(`Account ${accountId} is not active`);
        }
        lockedAccounts.set(accountId, row);
      }

      const balanceDeltas = new Map<string, bigint>();
      for (const entry of input.entries) {
        const delta = entry.direction === 'DEBIT' ? -entry.amountMinorUnits : entry.amountMinorUnits;
        balanceDeltas.set(entry.accountId, (balanceDeltas.get(entry.accountId) ?? 0n) + delta);
      }

      for (const [accountId, delta] of balanceDeltas) {
        const account = lockedAccounts.get(accountId)!;
        const newBalance = account.balanceMinorUnits + delta;
        if (newBalance < 0n) {
          throw new ConflictException(`Insufficient funds in account ${accountId}`);
        }
      }

      const group = await tx.ledgerEntryGroup.create({
        data: {
          organizationId: input.organizationId,
          paymentId: input.paymentId,
          idempotencyKey: input.idempotencyKey,
          description: input.description,
          entries: {
            create: input.entries.map((e) => ({
              accountId: e.accountId,
              direction: e.direction,
              amountMinorUnits: e.amountMinorUnits,
              currency: e.currency,
            })),
          },
        },
      });

      for (const [accountId, delta] of balanceDeltas) {
        await tx.account.update({
          where: { id: accountId },
          data: { balanceMinorUnits: { increment: delta } },
        });
      }

      await this.auditService.record(
        {
          organizationId: input.organizationId,
          actorId: input.actorUserId,
          action: 'ledger.posted',
          resourceType: 'LedgerEntryGroup',
          resourceId: group.id,
          newState: {
            description: input.description,
            entries: input.entries.map((e) => ({
              accountId: e.accountId,
              direction: e.direction,
              amountMinorUnits: e.amountMinorUnits.toString(),
              currency: e.currency,
            })),
          },
        },
        tx,
      );

      return group.id;
    });

    return { groupId, alreadyPosted: false };
  }

  /**
   * Finds this organization's SETTLEMENT account for `currency`, creating
   * one if it doesn't exist yet. SETTLEMENT accounts are the "destination-
   * side placeholder" from architecture §9's ledger diagram — the CREDIT
   * side of a payment that leaves the organization to an external
   * beneficiary, since the beneficiary itself isn't a row this system
   * owns. This is the only place a SETTLEMENT account is ever created,
   * mirroring the single-writer discipline `postDoubleEntry()` already
   * enforces for balance-affecting writes in general.
   *
   * find-then-create, same shape as `generateUniqueAccountNumber()` in
   * AccountsService, with the DB's partial unique index
   * (`accounts_settlement_org_currency_key`, Phase 10 migration) as the
   * real backstop against two concurrent callers both creating one for
   * the same (organizationId, currency) — the same defense-in-depth
   * posture used for idempotency keys elsewhere in this service.
   */
  async getOrCreateSettlementAccount(organizationId: string, currency: string) {
    const existing = await this.prisma.account.findFirst({
      where: { organizationId, currency, purpose: 'SETTLEMENT' },
    });
    if (existing) return existing;

    try {
      return await this.prisma.account.create({
        data: {
          organizationId,
          currency,
          accountNumber: `SETTLEMENT-${organizationId}-${currency}`,
          purpose: 'SETTLEMENT',
          status: 'ACTIVE',
        },
      });
    } catch {
      // Lost the create race to a concurrent caller — the partial unique
      // index rejected the duplicate. The winner's row is what we want.
      const winner = await this.prisma.account.findFirst({
        where: { organizationId, currency, purpose: 'SETTLEMENT' },
      });
      if (!winner) throw new ConflictException('Failed to resolve the settlement account for this currency.');
      return winner;
    }
  }

  /** Entries must net to exactly zero, per currency — the double-entry invariant. */
  private validateEntriesBalance(entries: LedgerEntryInput[]): void {
    if (entries.length < 2) {
      throw new UnprocessableEntityException('A ledger posting requires at least two entries');
    }
    const netByCurrency = new Map<string, bigint>();
    for (const entry of entries) {
      if (entry.amountMinorUnits <= 0n) {
        throw new UnprocessableEntityException('Ledger entry amounts must be positive');
      }
      const delta = entry.direction === 'DEBIT' ? entry.amountMinorUnits : -entry.amountMinorUnits;
      netByCurrency.set(entry.currency, (netByCurrency.get(entry.currency) ?? 0n) + delta);
    }
    for (const [currency, net] of netByCurrency) {
      if (net !== 0n) {
        throw new UnprocessableEntityException(`Ledger entries do not balance for currency ${currency}`);
      }
    }
  }
}

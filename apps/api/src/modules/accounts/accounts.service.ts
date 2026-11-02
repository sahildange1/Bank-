import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import * as crypto from 'crypto';
import { PrismaService } from '../../common/prisma/prisma.service';
import { TenantPrismaService } from '../../common/prisma/tenant-prisma.service';
import { AuditService } from '../audit/services/audit.service';
import { LedgerService } from '../ledger/services/ledger.service';
import { CreateAccountDto } from './dto/create-account.dto';
import { CreateTransferDto } from './dto/create-transfer.dto';

@Injectable()
export class AccountsService {
  constructor(
    private readonly prisma: PrismaService, // transaction-history reads only — see comment there
    private readonly tenantPrisma: TenantPrismaService,
    private readonly auditService: AuditService,
    private readonly ledgerService: LedgerService,
  ) {}

  async createAccount(organizationId: string, actorUserId: string, dto: CreateAccountDto) {
    const scoped = this.tenantPrisma.forOrg(organizationId);
    const accountNumber = await this.generateUniqueAccountNumber();

    const account = await scoped.account.create({
      data: { accountNumber, currency: dto.currency, status: 'ACTIVE' },
    });

    await this.auditService.record({
      organizationId,
      actorId: actorUserId,
      action: 'account.created',
      resourceType: 'Account',
      resourceId: account.id,
      newState: { accountNumber: account.accountNumber, currency: account.currency },
    });

    return account;
  }

  async listAccounts(organizationId: string) {
    const scoped = this.tenantPrisma.forOrg(organizationId);
    // SETTLEMENT accounts (Phase 10 — see LedgerService.getOrCreateSettlementAccount)
    // are internal ledger plumbing, not something a corporate user created
    // or should see in their own account list.
    return scoped.account.findMany({ where: { purpose: 'CUSTOMER' }, orderBy: { createdAt: 'asc' } });
  }

  async getAccount(organizationId: string, accountId: string) {
    const scoped = this.tenantPrisma.forOrg(organizationId);
    const account = await scoped.account.findUnique({ where: { id: accountId } });
    // Same reasoning as listAccounts(): a SETTLEMENT account isn't a 404
    // from the tenant-scope extension's perspective (it does belong to
    // this org), but it's still not a resource this endpoint should ever
    // hand back to a caller.
    if (!account || account.purpose !== 'CUSTOMER') throw new NotFoundException();
    return account;
  }

  async setAccountStatus(
    organizationId: string,
    actorUserId: string,
    accountId: string,
    status: 'ACTIVE' | 'FROZEN' | 'CLOSED',
  ) {
    const scoped = this.tenantPrisma.forOrg(organizationId);
    const existing = await scoped.account.findUnique({ where: { id: accountId } });
    if (!existing) throw new NotFoundException();

    if (status === 'CLOSED' && existing.balanceMinorUnits !== 0n) {
      throw new BadRequestException('Cannot close an account with a non-zero balance.');
    }

    const updated = await scoped.account.update({ where: { id: accountId }, data: { status } });

    await this.auditService.record({
      organizationId,
      actorId: actorUserId,
      action: 'account.status_changed',
      resourceType: 'Account',
      resourceId: accountId,
      previousState: { status: existing.status },
      newState: { status },
    });

    return updated;
  }

  /**
   * Transfers between two accounts the SAME organization already owns — no
   * beneficiary, no maker-checker. That's a deliberate scope line drawn
   * from the product brief's own separation of "Internal transfers" from
   * "Payment creation"/"Payment approval workflows" (§1): moving money
   * between your own accounts is lower-risk than paying an external
   * counterparty, so it doesn't need the heavier Payment state machine
   * (Phase 8/9) — it posts directly through LedgerService.
   */
  async createTransfer(organizationId: string, actorUserId: string, dto: CreateTransferDto) {
    if (dto.sourceAccountId === dto.destinationAccountId) {
      throw new BadRequestException('Source and destination accounts must be different.');
    }

    const scoped = this.tenantPrisma.forOrg(organizationId);
    const [source, destination] = await Promise.all([
      scoped.account.findUnique({ where: { id: dto.sourceAccountId } }),
      scoped.account.findUnique({ where: { id: dto.destinationAccountId } }),
    ]);
    if (!source || !destination) throw new NotFoundException('Source or destination account not found.');
    // A SETTLEMENT account (Phase 10) is internal ledger plumbing, not a
    // customer-facing account — never a valid leg of a customer-initiated
    // transfer, even though it technically belongs to this organization.
    if (source.purpose !== 'CUSTOMER' || destination.purpose !== 'CUSTOMER') {
      throw new NotFoundException('Source or destination account not found.');
    }

    // No FX support yet (flagged as an open question — see Phase 6 write-up):
    // both accounts and the transfer itself must share one currency.
    if (source.currency !== dto.currency || destination.currency !== dto.currency) {
      throw new BadRequestException(
        `Currency mismatch: transfer is ${dto.currency}, source is ${source.currency}, destination is ${destination.currency}. Cross-currency transfers are not supported.`,
      );
    }

    const amount = BigInt(dto.amountMinorUnits);
    if (amount <= 0n) {
      throw new BadRequestException('Transfer amount must be positive.');
    }

    const result = await this.ledgerService.postDoubleEntry({
      organizationId,
      actorUserId,
      description: dto.description,
      idempotencyKey: dto.idempotencyKey,
      entries: [
        { accountId: source.id, direction: 'DEBIT', amountMinorUnits: amount, currency: dto.currency },
        { accountId: destination.id, direction: 'CREDIT', amountMinorUnits: amount, currency: dto.currency },
      ],
    });

    return result;
  }

  /**
   * LedgerEntry has no organizationId column (it's reached only through its
   * scoped parent — see TENANT_SCOPED_MODELS in tenant-scope.extension.ts),
   * so this uses the raw client for the entry query itself, but only after
   * confirming via the SCOPED client that the account belongs to this org.
   * That ownership check is what makes the raw query safe.
   */
  async getAccountTransactions(organizationId: string, accountId: string) {
    const scoped = this.tenantPrisma.forOrg(organizationId);
    const account = await scoped.account.findUnique({ where: { id: accountId } });
    if (!account || account.purpose !== 'CUSTOMER') throw new NotFoundException();

    return this.prisma.ledgerEntry.findMany({
      where: { accountId },
      include: { group: { select: { description: true, postedAt: true, paymentId: true } } },
      orderBy: { createdAt: 'desc' },
    });
  }

  private async generateUniqueAccountNumber(): Promise<string> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const candidate = `ACC-${crypto.randomInt(0, 1_000_000_000).toString().padStart(9, '0')}`;
      const existing = await this.prisma.account.findUnique({ where: { accountNumber: candidate } });
      if (!existing) return candidate;
    }
    throw new Error('Could not generate a unique account number after 5 attempts');
  }
}

import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { APP_GUARD, APP_FILTER } from '@nestjs/core';

import { PrismaModule } from './common/prisma/prisma.module';
import { GuardsModule } from './common/guards/guards.module';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';

import { AuthModule } from './modules/auth/auth.module';
import { OrganizationsModule } from './modules/organizations/organizations.module';
import { UsersModule } from './modules/users/users.module';
import { AccountsModule } from './modules/accounts/accounts.module';
import { BeneficiariesModule } from './modules/beneficiaries/beneficiaries.module';
import { PaymentsModule } from './modules/payments/payments.module';
import { ApprovalsModule } from './modules/approvals/approvals.module';
import { LedgerModule } from './modules/ledger/ledger.module';
import { AuditModule } from './modules/audit/audit.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { ReportsModule } from './modules/reports/reports.module';
import { ApiClientsModule } from './modules/api-clients/api-clients.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 100 }]),
    PrismaModule,
    AuditModule, // imported early: other modules depend on AuditService
    AuthModule,
    GuardsModule,
    OrganizationsModule,
    UsersModule,
    AccountsModule,
    BeneficiariesModule,
    PaymentsModule,
    ApprovalsModule,
    LedgerModule,
    NotificationsModule,
    ReportsModule,
    ApiClientsModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_FILTER, useClass: HttpExceptionFilter },
  ],
})
export class AppModule {}

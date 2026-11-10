/**
 * Creates one platform-operator user in the seeded platform organization.
 * Credentials come from the environment, never from source:
 *
 *   PLATFORM_OPERATOR_EMAIL=ops@example.test \
 *   PLATFORM_OPERATOR_PASSWORD='<a long random passphrase>' \
 *   pnpm --filter @cbp/api exec ts-node prisma/create-platform-operator.ts
 *
 * Run `prisma db seed` first. The operator must then log in and enroll MFA
 * (POST /auth/mfa/enroll/start + /confirm): PlatformOperatorGuard refuses
 * every /admin call until a verified MFA factor exists.
 */
import { PrismaClient } from '@prisma/client';
import { PasswordService } from '../src/modules/auth/services/password.service';
import { PLATFORM_ROLE_NAME } from '../src/modules/organizations/constants/rbac-catalog';

const prisma = new PrismaClient();

async function main() {
  const email = process.env.PLATFORM_OPERATOR_EMAIL?.trim().toLowerCase();
  const password = process.env.PLATFORM_OPERATOR_PASSWORD;
  if (!email || !password) {
    throw new Error('PLATFORM_OPERATOR_EMAIL and PLATFORM_OPERATOR_PASSWORD must be set.');
  }
  if (password.length < 12) {
    throw new Error('PLATFORM_OPERATOR_PASSWORD must be at least 12 characters.');
  }

  const org = await prisma.organization.findFirst({ where: { isPlatform: true } });
  if (!org) throw new Error('No platform organization found. Run `prisma db seed` first.');
  const role = await prisma.role.findUniqueOrThrow({
    where: { organizationId_name: { organizationId: org.id, name: PLATFORM_ROLE_NAME } },
  });

  const passwordHash = await new PasswordService().hash(password);
  const user = await prisma.user.upsert({
    where: { organizationId_email: { organizationId: org.id, email } },
    update: {},
    create: { organizationId: org.id, email, passwordHash, status: 'ACTIVE' },
  });
  await prisma.userRole.upsert({
    where: { userId_roleId: { userId: user.id, roleId: role.id } },
    update: {},
    create: { userId: user.id, roleId: role.id },
  });
  // eslint-disable-next-line no-console
  console.log(`Platform operator ready: ${email} (${user.id}). Enroll MFA before using /admin.`);
}

main()
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err.message);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

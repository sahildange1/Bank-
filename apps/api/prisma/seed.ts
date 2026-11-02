/**
 * Seeds the global Permission catalog (shared across all organizations).
 * Role/RolePermission is per-organization and is materialized instead at
 * organization creation time — see OrganizationsService, which uses the
 * same PERMISSIONS / DEFAULT_ROLE_PERMISSIONS constants as the single
 * source of truth.
 */
import { PrismaClient } from '@prisma/client';
import { PERMISSIONS } from '../src/modules/organizations/constants/rbac-catalog';

const prisma = new PrismaClient();

async function main() {
  for (const permission of PERMISSIONS) {
    await prisma.permission.upsert({
      where: { key: permission.key },
      update: { description: permission.description },
      create: permission,
    });
  }
  // eslint-disable-next-line no-console
  console.log(`Seeded ${PERMISSIONS.length} permissions.`);
}

main()
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

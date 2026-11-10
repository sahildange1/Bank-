/**
 * Seeds the global Permission catalog (shared across all organizations),
 * plus — since Phase 13 — the single internal "platform" organization and
 * its 'Platform Operator' role. Customer-organization Role/RolePermission
 * rows are materialized at organization creation time instead (see
 * OrganizationsService); both use rbac-catalog.ts as the single source of
 * truth. Idempotent: safe to run repeatedly.
 *
 * Creating the first operator *user* is a separate step
 * (prisma/create-platform-operator.ts) because it needs a password, and
 * secrets are never hardcoded in a seed.
 */
import { PrismaClient } from '@prisma/client';
import {
  PERMISSIONS,
  PLATFORM_ORGANIZATION_NAME,
  PLATFORM_PERMISSIONS,
  PLATFORM_ROLE_NAME,
} from '../src/modules/organizations/constants/rbac-catalog';

const prisma = new PrismaClient();

async function main() {
  const allPermissions = [...PERMISSIONS, ...PLATFORM_PERMISSIONS];
  for (const permission of allPermissions) {
    await prisma.permission.upsert({
      where: { key: permission.key },
      update: { description: permission.description },
      create: permission,
    });
  }

  let platformOrg = await prisma.organization.findFirst({ where: { isPlatform: true } });
  if (!platformOrg) {
    platformOrg = await prisma.organization.create({
      data: { legalName: PLATFORM_ORGANIZATION_NAME, status: 'ACTIVE', isPlatform: true },
    });
  }

  const role = await prisma.role.upsert({
    where: { organizationId_name: { organizationId: platformOrg.id, name: PLATFORM_ROLE_NAME } },
    update: {},
    create: { organizationId: platformOrg.id, name: PLATFORM_ROLE_NAME, isSystemRole: true },
  });
  for (const p of PLATFORM_PERMISSIONS) {
    const permission = await prisma.permission.findUniqueOrThrow({ where: { key: p.key } });
    await prisma.rolePermission.upsert({
      where: { roleId_permissionId: { roleId: role.id, permissionId: permission.id } },
      update: {},
      create: { roleId: role.id, permissionId: permission.id },
    });
  }

  // eslint-disable-next-line no-console
  console.log(`Seeded ${allPermissions.length} permissions and the platform organization (${platformOrg.id}).`);
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

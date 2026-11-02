import { Global, Module } from '@nestjs/common';
import { SessionAuthGuard } from './session-auth.guard';
import { PermissionsGuard } from './permissions.guard';
import { AuthModule } from '../../modules/auth/auth.module';

// Global so any feature module can `@UseGuards(SessionAuthGuard, PermissionsGuard)`
// without importing AuthModule directly. Imports AuthModule (rather than the
// reverse) to avoid a circular dependency, since AuthController itself uses
// these guards on a few routes (logout, /me, mfa enrollment).
@Global()
@Module({
  imports: [AuthModule],
  providers: [SessionAuthGuard, PermissionsGuard],
  exports: [SessionAuthGuard, PermissionsGuard],
})
export class GuardsModule {}

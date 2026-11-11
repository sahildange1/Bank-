import { Global, Module } from '@nestjs/common';
import { SessionAuthGuard } from './session-auth.guard';
import { PermissionsGuard } from './permissions.guard';
import { AuthModule } from '../../modules/auth/auth.module';

// Global so any feature module can `@UseGuards(SessionAuthGuard, PermissionsGuard)`
// without importing AuthModule directly. Imports AuthModule (rather than the
// reverse) to avoid a circular dependency, since AuthController itself uses
// these guards on a few routes (logout, /me, mfa enrollment).
//
// AuthModule is also RE-EXPORTED on purpose: Nest instantiates a guard named
// in @UseGuards() inside the *using* module's scope, so SessionAuthGuard's
// own dependency (SessionService) must be visible there too. Without this
// re-export no feature module could resolve its guards and the API failed to
// start (src/test/app-wiring.spec.ts guards against a regression).
@Global()
@Module({
  imports: [AuthModule],
  providers: [SessionAuthGuard, PermissionsGuard],
  exports: [SessionAuthGuard, PermissionsGuard, AuthModule],
})
export class GuardsModule {}

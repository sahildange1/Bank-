import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { PasswordService } from './services/password.service';
import { TotpService } from './services/totp.service';
import { ChallengeTokenService } from './services/challenge-token.service';
import { SessionService } from './services/session.service';

@Module({
  controllers: [AuthController],
  providers: [AuthService, PasswordService, TotpService, ChallengeTokenService, SessionService],
  exports: [SessionService, PasswordService, ChallengeTokenService],
})
export class AuthModule {}

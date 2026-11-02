import { Body, Controller, Get, HttpCode, HttpStatus, Post, Req, Res, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Request, Response } from 'express';
import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { VerifyMfaDto } from './dto/verify-mfa.dto';
import { EnrollMfaConfirmDto } from './dto/enroll-mfa-confirm.dto';
import { ResetPasswordRequestDto } from './dto/reset-password-request.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { SessionAuthGuard, SESSION_COOKIE_NAME } from '../../common/guards/session-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { AuthContext } from '../../common/types/auth-context';

const SESSION_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'strict' as const,
  path: '/',
};

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('login')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @HttpCode(HttpStatus.OK)
  async login(@Body() dto: LoginDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const result = await this.authService.login(dto, req.ip, req.headers['user-agent']);
    if (result.session) {
      res.cookie(SESSION_COOKIE_NAME, result.session.id, {
        ...SESSION_COOKIE_OPTIONS,
        expires: result.session.expiresAt,
      });
      return { mfaRequired: false };
    }
    return { mfaRequired: true, challengeId: result.challengeId };
  }

  @Post('mfa/verify')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @HttpCode(HttpStatus.OK)
  async verifyMfa(@Body() dto: VerifyMfaDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const result = await this.authService.verifyMfa(dto, req.ip, req.headers['user-agent']);
    res.cookie(SESSION_COOKIE_NAME, result.session!.id, {
      ...SESSION_COOKIE_OPTIONS,
      expires: result.session!.expiresAt,
    });
    return { mfaRequired: false };
  }

  @Post('logout')
  @UseGuards(SessionAuthGuard)
  @HttpCode(HttpStatus.OK)
  async logout(@CurrentUser() user: AuthContext, @Res({ passthrough: true }) res: Response) {
    await this.authService.logout(user.sessionId, user.userId, user.organizationId);
    res.clearCookie(SESSION_COOKIE_NAME, SESSION_COOKIE_OPTIONS);
    return { success: true };
  }

  @Get('me')
  @UseGuards(SessionAuthGuard)
  me(@CurrentUser() user: AuthContext) {
    return { userId: user.userId, organizationId: user.organizationId, permissions: user.permissions };
  }

  @Post('mfa/enroll/start')
  @UseGuards(SessionAuthGuard)
  enrollMfaStart(@CurrentUser() user: AuthContext) {
    return this.authService.enrollMfaStart(user.userId);
  }

  @Post('mfa/enroll/confirm')
  @UseGuards(SessionAuthGuard)
  @HttpCode(HttpStatus.OK)
  enrollMfaConfirm(@CurrentUser() user: AuthContext, @Body() dto: EnrollMfaConfirmDto) {
    return this.authService.enrollMfaConfirm(user.userId, dto.code);
  }

  @Post('password/reset-request')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @HttpCode(HttpStatus.OK)
  async resetPasswordRequest(@Body() dto: ResetPasswordRequestDto) {
    await this.authService.requestPasswordReset(dto);
    return { success: true }; // always success — never reveals whether the email exists
  }

  @Post('password/reset')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @HttpCode(HttpStatus.OK)
  async resetPassword(@Body() dto: ResetPasswordDto) {
    await this.authService.resetPassword(dto);
    return { success: true };
  }
}

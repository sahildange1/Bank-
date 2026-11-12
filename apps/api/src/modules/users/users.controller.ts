import { Body, Controller, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { UsersService } from './users.service';
import { InviteUserDto } from './dto/invite-user.dto';
import { AcceptInviteDto } from './dto/accept-invite.dto';
import { UpdateUserRolesDto } from './dto/update-user-roles.dto';
import { SessionAuthGuard } from '../../common/guards/session-auth.guard';
import { PermissionsGuard } from '../../common/guards/permissions.guard';
import { RequirePermissions } from '../../common/decorators/require-permissions.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { AuthContext } from '../../common/types/auth-context';

@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Get()
  @UseGuards(SessionAuthGuard, PermissionsGuard)
  @RequirePermissions('users.manage')
  list(@CurrentUser() user: AuthContext) {
    return this.usersService.listUsers(user.organizationId);
  }

  @Post()
  @UseGuards(SessionAuthGuard, PermissionsGuard)
  @RequirePermissions('users.manage')
  invite(@CurrentUser() user: AuthContext, @Body() dto: InviteUserDto) {
    return this.usersService.inviteUser(user.organizationId, user.userId, user.permissions, dto);
  }

  @Post('accept-invite')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  acceptInvite(@Body() dto: AcceptInviteDto) {
    return this.usersService.acceptInvite(dto);
  }

  @Patch(':id/roles')
  @UseGuards(SessionAuthGuard, PermissionsGuard)
  @RequirePermissions('users.manage')
  updateRoles(@CurrentUser() user: AuthContext, @Param('id') targetUserId: string, @Body() dto: UpdateUserRolesDto) {
    return this.usersService.updateUserRoles(user.organizationId, user.userId, user.permissions, targetUserId, dto);
  }

  @Post(':id/disable')
  @UseGuards(SessionAuthGuard, PermissionsGuard)
  @RequirePermissions('users.manage')
  disable(@CurrentUser() user: AuthContext, @Param('id') targetUserId: string) {
    return this.usersService.setUserStatus(user.organizationId, user.userId, user.permissions, targetUserId, false);
  }

  @Post(':id/enable')
  @UseGuards(SessionAuthGuard, PermissionsGuard)
  @RequirePermissions('users.manage')
  enable(@CurrentUser() user: AuthContext, @Param('id') targetUserId: string) {
    return this.usersService.setUserStatus(user.organizationId, user.userId, user.permissions, targetUserId, true);
  }
}

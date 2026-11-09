import { Controller, Get, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common';
import { NotificationsService } from './services/notifications.service';
import { QueryNotificationsDto } from './dto/query-notifications.dto';
import { SessionAuthGuard } from '../../common/guards/session-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { AuthContext } from '../../common/types/auth-context';

/**
 * Every route is scoped to the calling user's OWN notifications, taken from
 * the session — there is no userId parameter anywhere. A role permission
 * would add nothing here (everyone may read their own inbox), so only
 * SessionAuthGuard applies.
 */
@Controller('notifications')
@UseGuards(SessionAuthGuard)
export class NotificationsController {
  constructor(private readonly notificationsService: NotificationsService) {}

  @Get()
  list(@CurrentUser() user: AuthContext, @Query() query: QueryNotificationsDto) {
    return this.notificationsService.list(user.organizationId, user.userId, query);
  }

  @Get('unread-count')
  unreadCount(@CurrentUser() user: AuthContext) {
    return this.notificationsService.unreadCount(user.organizationId, user.userId);
  }

  @Post('read-all')
  @HttpCode(200)
  markAllRead(@CurrentUser() user: AuthContext) {
    return this.notificationsService.markAllRead(user.organizationId, user.userId);
  }

  @Post(':id/read')
  @HttpCode(200)
  markRead(@CurrentUser() user: AuthContext, @Param('id') id: string) {
    return this.notificationsService.markRead(user.organizationId, user.userId, id);
  }
}

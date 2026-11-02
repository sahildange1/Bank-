import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { Request, Response } from 'express';
import * as crypto from 'crypto';
import { ForbiddenTenantAccessError } from '../prisma/tenant-scope.extension';

/**
 * Consistent { error: { code, message, requestId } } envelope for every
 * error response (architecture §14). Internal error details/stack traces
 * are logged server-side only, keyed by requestId, and never sent to the
 * client.
 */
@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('ExceptionFilter');

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();
    const requestId = crypto.randomUUID();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let code = 'INTERNAL_ERROR';
    let message = 'An unexpected error occurred.';

    if (exception instanceof ForbiddenTenantAccessError) {
      status = HttpStatus.NOT_FOUND; // deliberately not 403: don't confirm the resource exists in another tenant
      code = 'NOT_FOUND';
      message = 'The requested resource was not found.';
    } else if (exception instanceof HttpException) {
      status = exception.getStatus();
      const body = exception.getResponse();
      code = HttpStatus[status] ?? 'ERROR';
      message =
        typeof body === 'string'
          ? body
          : ((body as Record<string, unknown>).message as string | string[] | undefined)?.toString() ??
            exception.message;
    } else {
      this.logger.error(`[${requestId}] Unhandled exception on ${request.method} ${request.url}`, exception as Error);
    }

    if (status >= 500) {
      this.logger.error(`[${requestId}] ${status} on ${request.method} ${request.url}`);
    }

    response.status(status).json({
      error: { code, message, requestId },
    });
  }
}

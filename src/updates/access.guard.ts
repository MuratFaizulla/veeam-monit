import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { timingSafeEqual } from 'crypto';
import { AppConfig } from '../config/configuration';
import { TelegramService } from '../telegram/telegram.service';

/**
 * Who may call the Telegram endpoints, and when.
 *
 * Every admin endpoint used to open with the same `assertAdmin(key)` line and
 * carry the header in its signature to make that possible. Six copies of a
 * security check is six chances to add a seventh endpoint without one, and the
 * omission would look exactly like the rest of the file.
 *
 * Stated as a guard, the check is attached to the endpoint rather than
 * performed by it: a handler with no guard is visibly unguarded.
 *
 * The invariant in both key guards is that an unset key denies everything. An
 * unconfigured secret must never mean "no secret required" — that is how an
 * admin surface ends up open in the one deployment that forgot the variable.
 */
abstract class HeaderKeyGuard implements CanActivate {
  protected constructor(
    private readonly header: string,
    private readonly expected: string,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<{ headers: Record<string, unknown> }>();
    const value = request.headers[this.header];
    if (!this.expected || typeof value !== 'string' || !sameSecret(value, this.expected)) {
      throw new ForbiddenException();
    }
    return true;
  }
}

/** Compare authentication material without leaking a matching prefix in timing. */
const sameSecret = (actual: string, expected: string): boolean => {
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
};

@Injectable()
export class TelegramAdminGuard extends HeaderKeyGuard {
  constructor(config: ConfigService) {
    super('x-telegram-admin-key', config.getOrThrow<AppConfig['telegram']>('telegram').adminKey);
  }
}

@Injectable()
export class TelegramWebhookGuard extends HeaderKeyGuard {
  constructor(config: ConfigService) {
    super(
      'x-telegram-bot-api-secret-token',
      config.getOrThrow<AppConfig['telegram']>('telegram').webhookSecret,
    );
  }
}

/** Refuses the endpoints that would otherwise report a send that cannot happen. */
@Injectable()
export class TelegramEnabledGuard implements CanActivate {
  constructor(private readonly telegram: TelegramService) {}

  canActivate(): boolean {
    if (!this.telegram.enabled) {
      throw new ServiceUnavailableException('Telegram is not configured');
    }
    return true;
  }
}

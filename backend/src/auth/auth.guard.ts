import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
  createParamDecorator,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';
import { AppConfig } from '../config/configuration';
import { SessionStore, VeeamSessionData } from './session.store';

export interface RequestWithSession extends Request {
  veeamSession?: VeeamSessionData;
}

/** Rejects the request unless the session cookie maps to a live Veeam session. */
@Injectable()
export class AuthGuard implements CanActivate {
  private readonly cookieName: string;

  constructor(
    private readonly sessions: SessionStore,
    configService: ConfigService,
  ) {
    this.cookieName = configService.getOrThrow<AppConfig['session']>('session').cookieName;
  }

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<RequestWithSession>();
    const session = this.sessions.get(request.cookies?.[this.cookieName]);

    if (!session) {
      throw new UnauthorizedException('Not signed in');
    }

    this.sessions.touch(session);
    request.veeamSession = session;
    return true;
  }
}

/** Injects the session resolved by AuthGuard into a controller method. */
export const CurrentSession = createParamDecorator(
  (_data: unknown, context: ExecutionContext): VeeamSessionData => {
    const request = context.switchToHttp().getRequest<RequestWithSession>();
    if (!request.veeamSession) {
      throw new UnauthorizedException('Not signed in');
    }
    return request.veeamSession;
  },
);

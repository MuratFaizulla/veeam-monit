import { Body, Controller, Get, HttpCode, Post, Req, Res, UseGuards } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CookieOptions, Request, Response } from 'express';
import { AppConfig } from '../config/configuration';
import { AuthGuard, CurrentSession } from './auth.guard';
import { AuthService, SessionUser } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { VeeamSessionData } from './session.store';

@Controller('auth')
export class AuthController {
  private readonly sessionConfig: AppConfig['session'];

  constructor(
    private readonly auth: AuthService,
    configService: ConfigService,
  ) {
    this.sessionConfig = configService.getOrThrow<AppConfig['session']>('session');
  }

  @Post('login')
  @HttpCode(200)
  async login(
    @Body() dto: LoginDto,
    @Res({ passthrough: true }) response: Response,
  ): Promise<SessionUser> {
    const session = await this.auth.login(dto.username, dto.password);
    response.cookie(this.sessionConfig.cookieName, session.id, this.cookieOptions());
    return this.auth.describe(session);
  }

  @Post('logout')
  @HttpCode(200)
  async logout(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<{ success: true }> {
    await this.auth.logout(request.cookies?.[this.sessionConfig.cookieName]);
    response.clearCookie(this.sessionConfig.cookieName, this.cookieOptions());
    return { success: true };
  }

  @Get('me')
  @UseGuards(AuthGuard)
  me(@CurrentSession() session: VeeamSessionData): SessionUser {
    return this.auth.describe(session);
  }

  private cookieOptions(): CookieOptions {
    return {
      httpOnly: true,
      // "lax" still sends the cookie on top-level navigation while blocking
      // cross-site POSTs, which is the CSRF protection this MVP relies on.
      sameSite: 'lax',
      secure: this.sessionConfig.cookieSecure,
      path: '/',
      maxAge: this.sessionConfig.ttlMs,
    };
  }
}

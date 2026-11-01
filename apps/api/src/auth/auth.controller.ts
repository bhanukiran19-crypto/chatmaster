import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  Res,
  UnauthorizedException,
  Inject,
  UseGuards,
} from '@nestjs/common';
import type { CookieOptions, Request, Response } from 'express';
import { z } from 'zod';
import type { AuthRequestContext, AuthSession } from './auth.contracts.js';
import { AuthService } from './auth.service.js';
import { AUTH_SERVICE } from './auth.tokens.js';
import { ACCESS_COOKIE_NAME, CSRF_COOKIE_NAME } from './auth.security.js';
import { AuthenticatedTenantGuard } from './authenticated-tenant.guard.js';
import type { TenantContextRequest } from './tenant-auth-context.js';
import {
  emailVerificationSchema,
  loginSchema,
  passwordResetSchema,
  parseBody,
  phoneVerificationSchema,
  refreshCookieSchema,
  resetRequestSchema,
  signupSchema,
} from './auth.validation.js';

const ACCESS_COOKIE = ACCESS_COOKIE_NAME;
const REFRESH_COOKIE = '__Host-refresh';
const ACCESS_TTL_MS = 15 * 60 * 1000;
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function requestContext(request: Request): AuthRequestContext {
  const ip = z.union([z.ipv4(), z.ipv6()]).safeParse(request.ip);
  const userAgent = request
    .get('user-agent')
    ?.replace(/[\u0000-\u001f\u007f]/g, '')
    .slice(0, 512);
  return {
    ...(ip.success ? { ipAddress: ip.data } : {}),
    ...(userAgent ? { userAgent } : {}),
  };
}

function cookieOptions(httpOnly: boolean): CookieOptions {
  return {
    httpOnly,
    secure: true,
    sameSite: 'lax',
    path: '/',
  };
}

function setSessionCookies(response: Response, session: AuthSession): void {
  response.cookie(ACCESS_COOKIE, session.accessToken, {
    ...cookieOptions(true),
    maxAge: ACCESS_TTL_MS,
  });
  response.cookie(REFRESH_COOKIE, session.refreshToken, {
    ...cookieOptions(true),
    maxAge: REFRESH_TTL_MS,
  });
  response.cookie(CSRF_COOKIE_NAME, session.csrfToken, {
    ...cookieOptions(false),
    maxAge: REFRESH_TTL_MS,
  });
}

function clearSessionCookies(response: Response): void {
  response.clearCookie(ACCESS_COOKIE, cookieOptions(true));
  response.clearCookie(REFRESH_COOKIE, cookieOptions(true));
  response.clearCookie(CSRF_COOKIE_NAME, cookieOptions(false));
}

@Controller('auth')
export class AuthController {
  constructor(@Inject(AUTH_SERVICE) private readonly auth: AuthService) {}

  @Get('csrf')
  getCsrfToken(@Res({ passthrough: true }) response: Response) {
    const csrfToken = this.auth.createCsrfToken();
    response.cookie(CSRF_COOKIE_NAME, csrfToken, {
      ...cookieOptions(false),
      maxAge: REFRESH_TTL_MS,
    });
    return { csrfToken };
  }

  @Post('signup')
  @HttpCode(HttpStatus.CREATED)
  async signup(@Body() body: unknown, @Req() request: Request) {
    const input = parseBody(signupSchema, body);
    await this.auth.signup(
      { email: input.email, mobile: input.mobile, password: input.password },
      requestContext(request),
    );
    return { message: 'Verification instructions sent' };
  }

  @Post('verify/email')
  @HttpCode(HttpStatus.OK)
  async verifyEmail(@Body() body: unknown, @Req() request: Request) {
    const { token } = parseBody(emailVerificationSchema, body);
    await this.auth.verifyEmail(token, requestContext(request));
    return { message: 'Email verified' };
  }

  @Post('verify/mobile')
  @HttpCode(HttpStatus.OK)
  async verifyMobile(@Body() body: unknown, @Req() request: Request) {
    const { mobile, otp } = parseBody(phoneVerificationSchema, body);
    await this.auth.verifyMobile(mobile, otp, requestContext(request));
    return { message: 'Mobile number verified' };
  }

  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(
    @Body() body: unknown,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const input = parseBody(loginSchema, body);
    const session = await this.auth.login(
      input.identifier,
      input.password,
      requestContext(request),
    );
    setSessionCookies(response, session);
    return { user: session.user };
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  async refresh(@Req() request: Request, @Res({ passthrough: true }) response: Response) {
    const refreshToken = refreshCookieSchema.safeParse(request.cookies?.[REFRESH_COOKIE]);
    if (!refreshToken.success) {
      clearSessionCookies(response);
      throw new UnauthorizedException('Refresh token is missing or invalid');
    }
    try {
      const session = await this.auth.refresh(refreshToken.data, requestContext(request));
      setSessionCookies(response, session);
      return { user: session.user };
    } catch (error) {
      clearSessionCookies(response);
      throw error;
    }
  }

  @UseGuards(AuthenticatedTenantGuard)
  @Get('me')
  me(@Req() request: TenantContextRequest) {
    const tenantContext = request.tenantContext;
    if (!tenantContext) throw new UnauthorizedException('Session is missing');
    return { user: tenantContext.user };
  }

  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  async logout(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<void> {
    const refreshToken = refreshCookieSchema.safeParse(request.cookies?.[REFRESH_COOKIE]);
    await this.auth.logout(
      refreshToken.success ? refreshToken.data : undefined,
      requestContext(request),
    );
    clearSessionCookies(response);
  }

  @Post('password-reset/request')
  @HttpCode(HttpStatus.OK)
  async requestPasswordReset(@Body() body: unknown, @Req() request: Request) {
    const { email } = parseBody(resetRequestSchema, body);
    await this.auth.requestPasswordReset(email, requestContext(request));
    return { message: 'If an eligible account exists, reset instructions were sent' };
  }

  @Post('password-reset/complete')
  @HttpCode(HttpStatus.OK)
  async resetPassword(
    @Body() body: unknown,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const input = parseBody(passwordResetSchema, body);
    await this.auth.resetPassword(input.token, input.password, requestContext(request));
    clearSessionCookies(response);
    return { message: 'Password reset complete; sign in again' };
  }
}

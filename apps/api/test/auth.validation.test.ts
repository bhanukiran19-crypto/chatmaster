import { describe, expect, it } from 'vitest';
import type { ExecutionContext } from '@nestjs/common';
import {
  CSRF_COOKIE_NAME,
  CsrfGuard,
  makeCsrfToken,
  verifyCsrfToken,
} from '../src/auth/auth.security.js';
import {
  accessCookieSchema,
  loginSchema,
  refreshCookieSchema,
  signupSchema,
} from '../src/auth/auth.validation.js';

const csrfSecret = 'test-secret-for-csrf-that-exceeds-32-bytes';

describe('auth validation and CSRF', () => {
  it('rejects non-Gmail signup addresses, malformed mobiles, and extra fields', () => {
    expect(
      signupSchema.safeParse({
        email: 'person@example.com',
        mobile: '+14155550123',
        password: 'long-secure-password',
      }).success,
    ).toBe(false);
    expect(
      signupSchema.safeParse({
        email: 'person@gmail.com',
        mobile: '4155550123',
        password: 'long-secure-password',
      }).success,
    ).toBe(false);
    expect(
      signupSchema.safeParse({
        email: 'person@gmail.com',
        mobile: '+14155550123',
        password: 'long-secure-password',
        role: 'admin',
      }).success,
    ).toBe(false);
  });

  it('bounds and validates cookie token formats before crypto processing', () => {
    expect(refreshCookieSchema.safeParse('A'.repeat(43)).success).toBe(true);
    expect(refreshCookieSchema.safeParse('A'.repeat(5000)).success).toBe(false);
    expect(accessCookieSchema.safeParse('short').success).toBe(false);
    expect(accessCookieSchema.safeParse('x'.repeat(4097)).success).toBe(false);
  });

  it('accepts either a Gmail address or E.164 mobile for login', () => {
    expect(
      loginSchema.safeParse({ identifier: 'person@gmail.com', password: 'secret' }).success,
    ).toBe(true);
    expect(loginSchema.safeParse({ identifier: '+14155550123', password: 'secret' }).success).toBe(
      true,
    );
    expect(
      loginSchema.safeParse({ identifier: 'person@example.com', password: 'secret' }).success,
    ).toBe(false);
  });

  it('requires a signed double-submit CSRF token and matching header', () => {
    const token = makeCsrfToken(csrfSecret);
    expect(verifyCsrfToken(token, token, csrfSecret)).toBe(true);
    expect(verifyCsrfToken(token, 'attacker-controlled', csrfSecret)).toBe(false);
    expect(verifyCsrfToken(`${token}tampered`, `${token}tampered`, csrfSecret)).toBe(false);
    expect(verifyCsrfToken(token, token, 'different-secret-material-that-is-long-enough')).toBe(
      false,
    );

    const guard = new CsrfGuard(csrfSecret);
    const context = (method: string, cookie?: string, header?: string) =>
      ({
        switchToHttp: () => ({
          getRequest: () => ({
            method,
            cookies: cookie ? { [CSRF_COOKIE_NAME]: cookie } : {},
            get: (name: string) => (name.toLowerCase() === 'x-csrf-token' ? header : undefined),
          }),
        }),
      }) as unknown as ExecutionContext;

    expect(guard.canActivate(context('POST', token, token))).toBe(true);
    expect(() => guard.canActivate(context('POST', token, 'mismatched'))).toThrow(
      'CSRF validation failed',
    );
    expect(guard.canActivate(context('GET'))).toBe(true);
  });
});

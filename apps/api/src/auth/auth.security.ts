import { createHmac, randomBytes } from 'node:crypto';
import { ForbiddenException, Injectable } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { constantTimeEquals } from '@chatmaster/crypto';
import type { Request } from 'express';

export const ACCESS_COOKIE_NAME = '__Host-access';
export const CSRF_COOKIE_NAME = '__Host-csrf';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function csrfKey(secret: string): Buffer {
  return createHmac('sha256', secret).update('chatmaster/csrf-token/v1').digest();
}

export function makeCsrfToken(secret: string): string {
  const nonce = randomBytes(32).toString('base64url');
  const signature = createHmac('sha256', csrfKey(secret)).update(nonce).digest('base64url');
  return `${nonce}.${signature}`;
}

export function verifyCsrfToken(
  token: string | undefined,
  header: string | undefined,
  secret: string,
): boolean {
  if (!token || !header || token.length > 160 || !constantTimeEquals(token, header)) return false;
  const [nonce, signature, extra] = token.split('.');
  if (!nonce || !signature || extra !== undefined) return false;
  const expected = createHmac('sha256', csrfKey(secret)).update(nonce).digest('base64url');
  return constantTimeEquals(signature, expected);
}

@Injectable()
export class CsrfGuard implements CanActivate {
  constructor(private readonly secret: string) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    if (SAFE_METHODS.has(request.method.toUpperCase())) return true;
    if (request.path?.startsWith('/webhooks/')) return true;
    const cookie = request.cookies?.[CSRF_COOKIE_NAME];
    const header = request.get('x-csrf-token');
    if (!verifyCsrfToken(cookie, header, this.secret)) {
      throw new ForbiddenException('CSRF validation failed');
    }
    return true;
  }
}

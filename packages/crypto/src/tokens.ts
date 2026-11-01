import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** URL-safe random token, e.g. for webhook path ids and refresh tokens. */
export function generateOpaqueToken(bytes = 32): string {
  if (!Number.isInteger(bytes) || bytes < 16) {
    throw new RangeError('Opaque tokens must be at least 16 random bytes');
  }
  return randomBytes(bytes).toString('base64url');
}

/** Lower-case hex SHA-256, used to store tokens we only ever need to compare. */
export function sha256Hex(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Constant-time string comparison that does not leak length via early exit. */
export function constantTimeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) {
    // Still perform a comparison so timing does not reveal the length mismatch.
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

/** Compares a presented secret against its stored SHA-256 hash in constant time. */
export function verifyHashedSecret(presented: string, storedSha256Hex: string): boolean {
  return constantTimeEquals(sha256Hex(presented), storedSha256Hex);
}

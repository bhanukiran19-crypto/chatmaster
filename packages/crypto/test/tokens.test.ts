import { describe, expect, it } from 'vitest';

import {
  constantTimeEquals,
  generateOpaqueToken,
  sha256Hex,
  verifyHashedSecret,
} from '../src/index.js';

describe('tokens', () => {
  it('generates URL-safe tokens of the expected entropy', () => {
    const token = generateOpaqueToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(generateOpaqueToken()).not.toBe(token);
    expect(() => generateOpaqueToken(8)).toThrow(RangeError);
  });

  it('hashes deterministically with SHA-256', () => {
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('compares in constant time including differing lengths', () => {
    expect(constantTimeEquals('secret', 'secret')).toBe(true);
    expect(constantTimeEquals('secret', 'secreT')).toBe(false);
    expect(constantTimeEquals('secret', 'secret-longer')).toBe(false);
    expect(constantTimeEquals('', '')).toBe(true);
  });

  it('verifies a presented secret against its stored hash', () => {
    const secret = generateOpaqueToken();
    const stored = sha256Hex(secret);
    expect(verifyHashedSecret(secret, stored)).toBe(true);
    expect(verifyHashedSecret(`${secret}x`, stored)).toBe(false);
  });
});

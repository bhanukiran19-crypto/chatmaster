import { randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { EncryptionError, loadKeyringFromEnv } from '../src/index.js';

const k1 = randomBytes(32).toString('base64');
const k2 = randomBytes(32).toString('base64');

describe('loadKeyringFromEnv', () => {
  it('parses multiple versions and an explicit active version', () => {
    const ring = loadKeyringFromEnv({
      ENCRYPTION_KEYS: `1:${k1}, 2:${k2}`,
      ENCRYPTION_ACTIVE_KEY_VERSION: '1',
    });
    expect(ring.activeVersion).toBe(1);
    expect([...ring.keys.keys()].sort()).toEqual([1, 2]);
    expect(Buffer.from(ring.keys.get(2) ?? []).toString('base64')).toBe(k2);
  });

  it('defaults the active version to the highest listed', () => {
    const ring = loadKeyringFromEnv({ ENCRYPTION_KEYS: `1:${k1},3:${k2}` });
    expect(ring.activeVersion).toBe(3);
  });

  it.each([
    [{}, /not set/],
    [{ ENCRYPTION_KEYS: '' }, /not set/],
    [{ ENCRYPTION_KEYS: 'abc' }, /<version>:<base64 key>/],
    [{ ENCRYPTION_KEYS: `0:${k1}` }, />= 1/],
    [{ ENCRYPTION_KEYS: `x:${k1}` }, /positive integer/],
    [{ ENCRYPTION_KEYS: `1:${randomBytes(16).toString('base64')}` }, /32 bytes/],
    [{ ENCRYPTION_KEYS: '1:not*base64!' }, /32 bytes/],
    [{ ENCRYPTION_KEYS: `1:${k1},1:${k2}` }, /Duplicate/],
    [{ ENCRYPTION_KEYS: `1:${k1}`, ENCRYPTION_ACTIVE_KEY_VERSION: '2' }, /not present/],
  ])('rejects invalid configuration %j', (env, message) => {
    expect(() => loadKeyringFromEnv(env)).toThrow(EncryptionError);
    expect(() => loadKeyringFromEnv(env)).toThrow(message);
  });
});

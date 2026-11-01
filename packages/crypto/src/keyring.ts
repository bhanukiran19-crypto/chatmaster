import { EncryptionError } from './encryption-service.js';

export const AES_256_KEY_BYTES = 32;

export interface Keyring {
  readonly activeVersion: number;
  readonly keys: ReadonlyMap<number, Uint8Array>;
}

function parseVersion(raw: string): number {
  if (!/^\d{1,9}$/.test(raw)) {
    throw new EncryptionError(`Invalid key version "${raw}": must be a positive integer`);
  }
  const version = Number(raw);
  if (version < 1) {
    throw new EncryptionError(`Invalid key version "${raw}": must be >= 1`);
  }
  return version;
}

function decodeKey(version: number, base64: string): Uint8Array {
  const key = Buffer.from(base64, 'base64');
  if (key.length !== AES_256_KEY_BYTES || key.toString('base64') !== normalizeBase64(base64)) {
    throw new EncryptionError(
      `Key version ${String(version)} must be exactly ${String(AES_256_KEY_BYTES)} bytes of valid base64`,
    );
  }
  return new Uint8Array(key);
}

function normalizeBase64(value: string): string {
  return Buffer.from(value, 'base64').toString('base64');
}

/**
 * Parses `ENCRYPTION_KEYS="1:<base64>,2:<base64>"` and
 * `ENCRYPTION_ACTIVE_KEY_VERSION="2"`.
 *
 * Every listed key stays decryptable; only the active one is used to encrypt.
 * Rotation = add a new version, bump the active version, re-encrypt rows in the
 * background, then remove the old version once no rows reference it.
 */
export function loadKeyringFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Keyring {
  const rawKeys = env['ENCRYPTION_KEYS'];
  if (rawKeys === undefined || rawKeys.trim() === '') {
    throw new EncryptionError('ENCRYPTION_KEYS is not set');
  }

  const keys = new Map<number, Uint8Array>();
  for (const entry of rawKeys.split(',')) {
    const trimmed = entry.trim();
    if (trimmed === '') continue;
    const separator = trimmed.indexOf(':');
    if (separator === -1) {
      throw new EncryptionError('ENCRYPTION_KEYS entries must be "<version>:<base64 key>"');
    }
    const version = parseVersion(trimmed.slice(0, separator));
    if (keys.has(version)) {
      throw new EncryptionError(`Duplicate key version ${String(version)} in ENCRYPTION_KEYS`);
    }
    keys.set(version, decodeKey(version, trimmed.slice(separator + 1)));
  }
  if (keys.size === 0) {
    throw new EncryptionError('ENCRYPTION_KEYS contains no keys');
  }

  const rawActive = env['ENCRYPTION_ACTIVE_KEY_VERSION'];
  const activeVersion =
    rawActive === undefined || rawActive.trim() === ''
      ? Math.max(...keys.keys())
      : parseVersion(rawActive.trim());
  if (!keys.has(activeVersion)) {
    throw new EncryptionError(
      `ENCRYPTION_ACTIVE_KEY_VERSION=${String(activeVersion)} is not present in ENCRYPTION_KEYS`,
    );
  }

  return { activeVersion, keys };
}

export function createKeyring(keys: Record<number, Uint8Array>, activeVersion?: number): Keyring {
  const map = new Map<number, Uint8Array>();
  for (const [rawVersion, key] of Object.entries(keys)) {
    const version = parseVersion(rawVersion);
    if (key.length !== AES_256_KEY_BYTES) {
      throw new EncryptionError(
        `Key version ${String(version)} must be exactly ${String(AES_256_KEY_BYTES)} bytes`,
      );
    }
    map.set(version, key);
  }
  if (map.size === 0) {
    throw new EncryptionError('Keyring must contain at least one key');
  }
  const active = activeVersion ?? Math.max(...map.keys());
  if (!map.has(active)) {
    throw new EncryptionError(`Active key version ${String(active)} is not in the keyring`);
  }
  return { activeVersion: active, keys: map };
}

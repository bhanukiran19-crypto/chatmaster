/**
 * Result of encrypting a value. `ciphertext` is self-describing (it embeds the
 * format version, key version, IV and auth tag) so it can be stored in a single
 * `bytea` column. `keyVersion` is returned separately so callers can persist it
 * in its own indexed column for rotation queries.
 */
export interface EncryptedPayload {
  readonly ciphertext: Uint8Array;
  readonly keyVersion: number;
}

/**
 * Abstraction over at-rest encryption of third-party secrets (e.g. Telegram bot
 * tokens). The default implementation uses local AES-256-GCM keys; a KMS-backed
 * implementation can replace it without touching callers.
 */
export interface EncryptionService {
  /** Version used for new ciphertexts. */
  readonly activeKeyVersion: number;

  /**
   * @param plaintext UTF-8 string or raw bytes.
   * @param aad Optional additional authenticated data (e.g. the owning tenant
   *            id). Must be supplied identically on decrypt; binds a ciphertext
   *            to its context so it cannot be replayed into another row.
   */
  encrypt(plaintext: string | Uint8Array, aad?: string): EncryptedPayload;

  decrypt(ciphertext: Uint8Array, aad?: string): Uint8Array;

  decryptToString(ciphertext: Uint8Array, aad?: string): string;

  /** Reads the key version embedded in a ciphertext without decrypting it. */
  keyVersionOf(ciphertext: Uint8Array): number;

  /** True when the ciphertext was produced with a key other than the active one. */
  needsRotation(ciphertext: Uint8Array): boolean;

  /** Decrypts with the embedded key and re-encrypts with the active key. */
  rotate(ciphertext: Uint8Array, aad?: string): EncryptedPayload;
}

export class EncryptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EncryptionError';
  }
}

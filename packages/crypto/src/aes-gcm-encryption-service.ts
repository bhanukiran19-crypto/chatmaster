import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

import {
  EncryptionError,
  type EncryptedPayload,
  type EncryptionService,
} from './encryption-service.js';
import type { Keyring } from './keyring.js';

/*
 * Ciphertext layout (all big-endian):
 *
 *   offset  size  field
 *   0       1     format version (currently 0x01)
 *   1       4     key version (uint32)
 *   5       12    IV / nonce (random per record)
 *   17      16    GCM authentication tag
 *   33      n     ciphertext
 *
 * The header (format + key version) is also fed to GCM as additional
 * authenticated data, so tampering with the key version is detected.
 */
const FORMAT_VERSION = 0x01;
const FORMAT_BYTES = 1;
const KEY_VERSION_BYTES = 4;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const HEADER_BYTES = FORMAT_BYTES + KEY_VERSION_BYTES;
const MIN_LENGTH = HEADER_BYTES + IV_BYTES + TAG_BYTES;
const ALGORITHM = 'aes-256-gcm';

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder('utf-8', { fatal: true });

export class AesGcmEncryptionService implements EncryptionService {
  readonly activeKeyVersion: number;
  readonly #keys: ReadonlyMap<number, Uint8Array>;

  constructor(keyring: Keyring) {
    if (!keyring.keys.has(keyring.activeVersion)) {
      throw new EncryptionError('Active key version is missing from keyring');
    }
    this.activeKeyVersion = keyring.activeVersion;
    this.#keys = new Map(keyring.keys);
  }

  encrypt(plaintext: string | Uint8Array, aad?: string): EncryptedPayload {
    const keyVersion = this.activeKeyVersion;
    const key = this.#keyFor(keyVersion);
    const header = encodeHeader(keyVersion);
    const iv = randomBytes(IV_BYTES);
    const data = typeof plaintext === 'string' ? textEncoder.encode(plaintext) : plaintext;

    const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
    cipher.setAAD(buildAad(header, aad));
    const body = Buffer.concat([cipher.update(data), cipher.final()]);
    const tag = cipher.getAuthTag();

    return {
      ciphertext: new Uint8Array(Buffer.concat([header, iv, tag, body])),
      keyVersion,
    };
  }

  decrypt(ciphertext: Uint8Array, aad?: string): Uint8Array {
    const { header, keyVersion, iv, tag, body } = parseCiphertext(ciphertext);
    const key = this.#keyFor(keyVersion);

    const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
    decipher.setAAD(buildAad(header, aad));
    decipher.setAuthTag(tag);
    try {
      return new Uint8Array(Buffer.concat([decipher.update(body), decipher.final()]));
    } catch {
      throw new EncryptionError(
        'Decryption failed: ciphertext is corrupt, tampered or AAD mismatch',
      );
    }
  }

  decryptToString(ciphertext: Uint8Array, aad?: string): string {
    try {
      return textDecoder.decode(this.decrypt(ciphertext, aad));
    } catch (error) {
      if (error instanceof EncryptionError) throw error;
      throw new EncryptionError('Decrypted bytes are not valid UTF-8');
    }
  }

  keyVersionOf(ciphertext: Uint8Array): number {
    return parseCiphertext(ciphertext).keyVersion;
  }

  needsRotation(ciphertext: Uint8Array): boolean {
    return this.keyVersionOf(ciphertext) !== this.activeKeyVersion;
  }

  rotate(ciphertext: Uint8Array, aad?: string): EncryptedPayload {
    return this.encrypt(this.decrypt(ciphertext, aad), aad);
  }

  #keyFor(version: number): Uint8Array {
    const key = this.#keys.get(version);
    if (key === undefined) {
      throw new EncryptionError(`No encryption key for version ${String(version)}`);
    }
    return key;
  }
}

function encodeHeader(keyVersion: number): Buffer {
  const header = Buffer.alloc(HEADER_BYTES);
  header.writeUInt8(FORMAT_VERSION, 0);
  header.writeUInt32BE(keyVersion, FORMAT_BYTES);
  return header;
}

function buildAad(header: Buffer, aad: string | undefined): Buffer {
  return aad === undefined ? header : Buffer.concat([header, Buffer.from(aad, 'utf8')]);
}

interface ParsedCiphertext {
  header: Buffer;
  keyVersion: number;
  iv: Buffer;
  tag: Buffer;
  body: Buffer;
}

function parseCiphertext(ciphertext: Uint8Array): ParsedCiphertext {
  if (ciphertext.length < MIN_LENGTH) {
    throw new EncryptionError('Ciphertext is too short');
  }
  const buf = Buffer.from(ciphertext.buffer, ciphertext.byteOffset, ciphertext.byteLength);
  const format = buf.readUInt8(0);
  if (format !== FORMAT_VERSION) {
    throw new EncryptionError(`Unsupported ciphertext format version ${String(format)}`);
  }
  const keyVersion = buf.readUInt32BE(FORMAT_BYTES);
  let offset = HEADER_BYTES;
  const header = buf.subarray(0, offset);
  const iv = buf.subarray(offset, (offset += IV_BYTES));
  const tag = buf.subarray(offset, (offset += TAG_BYTES));
  const body = buf.subarray(offset);
  return { header, keyVersion, iv, tag, body };
}

import { randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { AesGcmEncryptionService, EncryptionError, createKeyring } from '../src/index.js';

const KEY_V1 = new Uint8Array(randomBytes(32));
const KEY_V2 = new Uint8Array(randomBytes(32));

const HEADER_BYTES = 5;
const IV_BYTES = 12;
const TAG_BYTES = 16;

function service(active?: number): AesGcmEncryptionService {
  return new AesGcmEncryptionService(createKeyring({ 1: KEY_V1, 2: KEY_V2 }, active));
}

function flipBit(bytes: Uint8Array, index: number): Uint8Array {
  const copy = new Uint8Array(bytes);
  const current = copy[index];
  if (current === undefined) throw new Error('index out of range');
  copy[index] = current ^ 0x01;
  return copy;
}

describe('AesGcmEncryptionService', () => {
  it('round-trips a UTF-8 string', () => {
    const svc = service();
    const token = '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw';
    const { ciphertext } = svc.encrypt(token);
    expect(svc.decryptToString(ciphertext)).toBe(token);
  });

  it('round-trips raw bytes including empty input', () => {
    const svc = service();
    const bytes = new Uint8Array(randomBytes(257));
    expect(svc.decrypt(svc.encrypt(bytes).ciphertext)).toEqual(bytes);
    expect(svc.decrypt(svc.encrypt(new Uint8Array()).ciphertext)).toEqual(new Uint8Array());
  });

  it('produces the documented layout: header | 12-byte IV | 16-byte tag | body', () => {
    const svc = service(2);
    const plaintext = 'hello';
    const { ciphertext, keyVersion } = svc.encrypt(plaintext);
    expect(keyVersion).toBe(2);
    expect(ciphertext.length).toBe(HEADER_BYTES + IV_BYTES + TAG_BYTES + plaintext.length);
    expect(ciphertext[0]).toBe(0x01);
    expect(Buffer.from(ciphertext).readUInt32BE(1)).toBe(2);
  });

  it('uses a fresh random IV for every call', () => {
    const svc = service();
    const a = svc.encrypt('same').ciphertext;
    const b = svc.encrypt('same').ciphertext;
    expect(Buffer.from(a).subarray(HEADER_BYTES, HEADER_BYTES + IV_BYTES)).not.toEqual(
      Buffer.from(b).subarray(HEADER_BYTES, HEADER_BYTES + IV_BYTES),
    );
    expect(a).not.toEqual(b);
  });

  it('encrypts with the active key version and records it in the ciphertext', () => {
    const v1 = service(1);
    const v2 = service(2);
    expect(v1.activeKeyVersion).toBe(1);
    expect(v2.activeKeyVersion).toBe(2);
    expect(v1.keyVersionOf(v1.encrypt('x').ciphertext)).toBe(1);
    expect(v2.keyVersionOf(v2.encrypt('x').ciphertext)).toBe(2);
  });

  it('defaults the active version to the highest key version', () => {
    expect(service().activeKeyVersion).toBe(2);
  });

  it('decrypts ciphertexts from older key versions', () => {
    const old = service(1);
    const current = service(2);
    const { ciphertext } = old.encrypt('legacy');
    expect(current.decryptToString(ciphertext)).toBe('legacy');
    expect(current.needsRotation(ciphertext)).toBe(true);
    expect(current.needsRotation(current.encrypt('new').ciphertext)).toBe(false);
  });

  it('rotate() re-encrypts under the active key preserving plaintext and AAD', () => {
    const old = service(1);
    const current = service(2);
    const aad = 'tenant-123';
    const legacy = old.encrypt('secret', aad).ciphertext;
    const rotated = current.rotate(legacy, aad);
    expect(rotated.keyVersion).toBe(2);
    expect(current.keyVersionOf(rotated.ciphertext)).toBe(2);
    expect(current.decryptToString(rotated.ciphertext, aad)).toBe('secret');
    expect(() => current.decryptToString(rotated.ciphertext, 'tenant-999')).toThrow(
      EncryptionError,
    );
  });

  it('fails when the key version in the ciphertext is unknown', () => {
    const onlyV2 = new AesGcmEncryptionService(createKeyring({ 2: KEY_V2 }));
    const { ciphertext } = service(1).encrypt('x');
    expect(() => onlyV2.decrypt(ciphertext)).toThrow(/No encryption key for version 1/);
  });

  it('binds ciphertext to AAD', () => {
    const svc = service();
    const { ciphertext } = svc.encrypt('bound', 'tenant-a');
    expect(svc.decryptToString(ciphertext, 'tenant-a')).toBe('bound');
    expect(() => svc.decrypt(ciphertext, 'tenant-b')).toThrow(EncryptionError);
    expect(() => svc.decrypt(ciphertext)).toThrow(EncryptionError);
  });

  it.each([
    ['key version header', 4],
    ['IV', HEADER_BYTES],
    ['auth tag', HEADER_BYTES + IV_BYTES],
    ['body', HEADER_BYTES + IV_BYTES + TAG_BYTES],
  ])('detects tampering with the %s', (_label, index) => {
    const svc = service();
    const { ciphertext } = svc.encrypt('integrity');
    expect(() => svc.decrypt(flipBit(ciphertext, index))).toThrow(EncryptionError);
  });

  it('rejects truncated input and unknown format versions', () => {
    const svc = service();
    expect(() => svc.decrypt(new Uint8Array(10))).toThrow(/too short/);
    const { ciphertext } = svc.encrypt('x');
    const badFormat = new Uint8Array(ciphertext);
    badFormat[0] = 0x7f;
    expect(() => svc.decrypt(badFormat)).toThrow(/Unsupported ciphertext format/);
  });

  it('does not leak the plaintext in the ciphertext', () => {
    const svc = service();
    const secret = 'super-secret-bot-token';
    const { ciphertext } = svc.encrypt(secret);
    expect(Buffer.from(ciphertext).includes(Buffer.from(secret))).toBe(false);
  });

  it('rejects wrong-length keys', () => {
    expect(() => createKeyring({ 1: new Uint8Array(16) })).toThrow(/32 bytes/);
    expect(() => createKeyring({ 1: KEY_V1 }, 3)).toThrow(/not in the keyring/);
  });
});

import * as assert from 'assert';
import * as crypto from 'crypto';
import {
  createTokenDecoder,
  decryptMacBlob,
  decryptWindowsBlob,
  deriveMacKey,
  isSafeStorageValue,
  SAFE_STORAGE_PREFIX,
  TokenDecryptError,
} from '../safeStorage';

const TOKEN = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0ZXN0In0.c2lnbmF0dXJl';

/** Encrypt the way Chromium os_crypt does on Windows: v10 | nonce | ciphertext | tag. */
function windowsBlob(key: Buffer, plain: string): Buffer {
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return Buffer.concat([Buffer.from('v10'), nonce, ct, cipher.getAuthTag()]);
}

/** Encrypt the way Chromium os_crypt does on macOS: v10 | AES-128-CBC, IV of spaces. */
function macBlob(key: Buffer, plain: string): Buffer {
  const cipher = crypto.createCipheriv('aes-128-cbc', key, Buffer.alloc(16, 0x20));
  return Buffer.concat([Buffer.from('v10'), cipher.update(plain, 'utf8'), cipher.final()]);
}

const stored = (blob: Buffer) => SAFE_STORAGE_PREFIX + blob.toString('base64');

describe('safeStorage', () => {
  describe('isSafeStorageValue', () => {
    it('detects the Cursor safe-storage prefix', () => {
      assert.strictEqual(isSafeStorageValue('cursor-safe-storage:v1:djEw'), true);
      assert.strictEqual(isSafeStorageValue(TOKEN), false);
    });
  });

  describe('decryptWindowsBlob', () => {
    const key = crypto.randomBytes(32);

    it('decrypts an AES-256-GCM v10 blob', () => {
      assert.strictEqual(decryptWindowsBlob(key, windowsBlob(key, TOKEN)), TOKEN);
    });

    it('rejects a blob encrypted under another key', () => {
      assert.throws(() => decryptWindowsBlob(crypto.randomBytes(32), windowsBlob(key, TOKEN)));
    });

    it('rejects a tampered blob', () => {
      const blob = windowsBlob(key, TOKEN);
      blob[20] ^= 0xff;
      assert.throws(() => decryptWindowsBlob(key, blob));
    });

    it('rejects an unknown version tag', () => {
      const blob = windowsBlob(key, TOKEN);
      blob.write('v20', 0, 'latin1');
      assert.throws(() => decryptWindowsBlob(key, blob), /unrecognized encryption version/);
    });
  });

  describe('decryptMacBlob', () => {
    it('decrypts an AES-128-CBC v10 blob keyed from the Keychain password', () => {
      const key = deriveMacKey('keychain-password');
      assert.strictEqual(key.length, 16);
      assert.strictEqual(decryptMacBlob(key, macBlob(key, TOKEN)), TOKEN);
    });

    it('derives the Chromium os_crypt key (PBKDF2-SHA1, saltysalt, 1003)', () => {
      const expected = crypto.pbkdf2Sync('pw', 'saltysalt', 1003, 16, 'sha1');
      assert.deepStrictEqual(deriveMacKey('pw'), expected);
    });

    it('rejects a blob encrypted under another password', () => {
      const blob = macBlob(deriveMacKey('right'), TOKEN);
      assert.throws(() => decryptMacBlob(deriveMacKey('wrong'), blob));
    });
  });

  describe('createTokenDecoder', () => {
    it('passes plaintext tokens through without loading a key', async () => {
      let loads = 0;
      const decoder = createTokenDecoder(decryptWindowsBlob, async () => {
        loads++;
        return crypto.randomBytes(32);
      });
      assert.strictEqual(await decoder.decode(TOKEN), TOKEN);
      assert.strictEqual(loads, 0);
    });

    it('decrypts prefixed values and unwraps the key only once', async () => {
      const key = crypto.randomBytes(32);
      let loads = 0;
      const decoder = createTokenDecoder(decryptWindowsBlob, async () => {
        loads++;
        return key;
      });
      const value = stored(windowsBlob(key, TOKEN));
      assert.strictEqual(await decoder.decode(value), TOKEN);
      assert.strictEqual(await decoder.decode(value), TOKEN);
      assert.strictEqual(loads, 1);
    });

    it('drops a stale cached key and unwraps again once', async () => {
      const oldKey = crypto.randomBytes(32);
      const newKey = crypto.randomBytes(32);
      const keys = [oldKey, newKey];
      let loads = 0;
      const decoder = createTokenDecoder(decryptWindowsBlob, async () => keys[loads++]);
      assert.strictEqual(await decoder.decode(stored(windowsBlob(oldKey, TOKEN))), TOKEN);
      // Cursor rotated its master key: the cached one no longer authenticates.
      assert.strictEqual(await decoder.decode(stored(windowsBlob(newKey, TOKEN))), TOKEN);
      assert.strictEqual(loads, 2);
    });

    it('reports a UI-safe error when a freshly loaded key fails', async () => {
      const decoder = createTokenDecoder(decryptWindowsBlob, async () => crypto.randomBytes(32));
      const value = stored(windowsBlob(crypto.randomBytes(32), TOKEN));
      await assert.rejects(decoder.decode(value), (e: unknown) => {
        assert.ok(e instanceof TokenDecryptError);
        assert.strictEqual(e.message, 'decryption failed');
        return true;
      });
    });

    it('retries the key load after a loader failure', async () => {
      const key = crypto.randomBytes(32);
      let loads = 0;
      const decoder = createTokenDecoder(decryptWindowsBlob, async () => {
        if (loads++ === 0) {
          throw new TokenDecryptError('Windows DPAPI could not unwrap the key');
        }
        return key;
      });
      const value = stored(windowsBlob(key, TOKEN));
      await assert.rejects(decoder.decode(value), /DPAPI could not unwrap/);
      assert.strictEqual(await decoder.decode(value), TOKEN);
    });

    it('reports unsupported platforms without sending ciphertext anywhere', async () => {
      const decoder = createTokenDecoder(undefined, async () => crypto.randomBytes(32));
      await assert.rejects(decoder.decode(SAFE_STORAGE_PREFIX + 'djEw'), /not supported on/);
      assert.strictEqual(await decoder.decode(TOKEN), TOKEN);
    });
  });
});

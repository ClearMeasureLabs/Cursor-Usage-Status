import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import { resolveCursorUserDataDir } from './cursorAuth';

/**
 * Cursor encrypts `cursorAuth/accessToken` at rest behind the server-side feature gate
 * `cursor_auth_token_encryption_at_rest`. The stored value is this prefix followed by the
 * base64 of an Electron safeStorage blob, which is Chromium os_crypt ciphertext. Values without
 * the prefix are plaintext; Cursor's own decoder passes them through, and so does this one.
 */
export const SAFE_STORAGE_PREFIX = 'cursor-safe-storage:v1:';

/** os_crypt version tag on both Windows (AES-256-GCM) and macOS (AES-128-CBC) blobs. */
const OS_CRYPT_V10 = 'v10';

/** Failure whose message is safe to show in the UI: no token, key, or path content. */
export class TokenDecryptError extends Error {}

export function isSafeStorageValue(raw: string): boolean {
  return raw.startsWith(SAFE_STORAGE_PREFIX);
}

function assertTokenLike(plain: string): string {
  // GCM authenticates, but CBC with a wrong key can occasionally unpad cleanly into garbage.
  if (plain.length === 0 || !/^[\x21-\x7e]+$/.test(plain)) {
    throw new TokenDecryptError('decrypted value is not a token');
  }
  return plain;
}

function assertV10(blob: Buffer): void {
  if (blob.subarray(0, 3).toString('latin1') !== OS_CRYPT_V10) {
    throw new TokenDecryptError('unrecognized encryption version');
  }
}

/** Windows os_crypt v10: `v10` | 12-byte nonce | ciphertext | 16-byte GCM tag. */
export function decryptWindowsBlob(key: Buffer, blob: Buffer): string {
  assertV10(blob);
  if (blob.length < 3 + 12 + 16) {
    throw new TokenDecryptError('encrypted value is truncated');
  }
  const nonce = blob.subarray(3, 15);
  const tag = blob.subarray(blob.length - 16);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(blob.subarray(15, blob.length - 16)), decipher.final()]);
  return assertTokenLike(plain.toString('utf8'));
}

/** macOS os_crypt key: PBKDF2-SHA1 over the Keychain password, fixed salt and iteration count. */
export function deriveMacKey(keychainPassword: string): Buffer {
  return crypto.pbkdf2Sync(keychainPassword, 'saltysalt', 1003, 16, 'sha1');
}

/** macOS os_crypt v10: `v10` | AES-128-CBC ciphertext, IV of 16 spaces, PKCS#7 padding. */
export function decryptMacBlob(key: Buffer, blob: Buffer): string {
  assertV10(blob);
  const decipher = crypto.createDecipheriv('aes-128-cbc', key, Buffer.alloc(16, 0x20));
  const plain = Buffer.concat([decipher.update(blob.subarray(3)), decipher.final()]);
  return assertTokenLike(plain.toString('utf8'));
}

export type TokenDecoder = {
  /** Returns the usable bearer token, decrypting when the value carries the safe-storage prefix. */
  decode(raw: string): Promise<string>;
};

/**
 * Wraps a platform key loader with an in-memory cache. The master key is unwrapped once per
 * extension-host lifetime and never written anywhere. If a cached key stops working (Cursor
 * rotated it), it is dropped and unwrapped again once before giving up.
 */
export function createTokenDecoder(
  decryptBlob: ((key: Buffer, blob: Buffer) => string) | undefined,
  loadKey: () => Promise<Buffer>
): TokenDecoder {
  let cached: Promise<Buffer> | undefined;
  const getKey = (): Promise<Buffer> => {
    if (!cached) {
      const pending = loadKey();
      cached = pending;
      pending.catch(() => {
        if (cached === pending) {
          cached = undefined;
        }
      });
    }
    return cached;
  };

  return {
    async decode(raw: string): Promise<string> {
      if (!isSafeStorageValue(raw)) {
        return raw;
      }
      if (!decryptBlob) {
        throw new TokenDecryptError(`not supported on ${process.platform} yet`);
      }
      const blob = Buffer.from(raw.slice(SAFE_STORAGE_PREFIX.length), 'base64');
      const wasCached = cached !== undefined;
      try {
        return decryptBlob(await getKey(), blob);
      } catch (first) {
        if (!wasCached) {
          throw asDecryptError(first);
        }
        cached = undefined;
        try {
          return decryptBlob(await getKey(), blob);
        } catch (second) {
          throw asDecryptError(second);
        }
      }
    },
  };
}

function asDecryptError(e: unknown): TokenDecryptError {
  return e instanceof TokenDecryptError ? e : new TokenDecryptError('decryption failed');
}

function run(file: string, args: string[], stdin: string | undefined, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    const out: Buffer[] = [];
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout.on('data', (c: Buffer) => out.push(c));
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve(Buffer.concat(out).toString('utf8').trim());
      } else {
        reject(new Error(`exit ${code}`));
      }
    });
    child.stdin.end(stdin ?? '');
  });
}

const DPAPI_UNPROTECT =
  'Add-Type -AssemblyName System.Security;' +
  '$b=[Convert]::FromBase64String([Console]::In.ReadToEnd());' +
  "[Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Unprotect($b,$null,'CurrentUser'))";

/** Cursor's AES-256 master key: `Local State` os_crypt.encrypted_key, DPAPI-wrapped for this user. */
async function loadWindowsKey(): Promise<Buffer> {
  let wrapped: Buffer;
  try {
    const localState = JSON.parse(fs.readFileSync(path.join(resolveCursorUserDataDir(), 'Local State'), 'utf8'));
    wrapped = Buffer.from(String(localState?.os_crypt?.encrypted_key ?? ''), 'base64');
  } catch {
    throw new TokenDecryptError("could not read Cursor's Local State");
  }
  if (wrapped.subarray(0, 5).toString('latin1') !== 'DPAPI') {
    throw new TokenDecryptError("Cursor's Local State has no DPAPI key");
  }
  // Absolute path: never resolve powershell.exe through PATH. The key travels on stdin, not argv.
  const powershell = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  let unwrapped: string;
  try {
    unwrapped = await run(
      powershell,
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', DPAPI_UNPROTECT],
      wrapped.subarray(5).toString('base64'),
      20_000
    );
  } catch {
    throw new TokenDecryptError('Windows DPAPI could not unwrap the key');
  }
  const key = Buffer.from(unwrapped, 'base64');
  if (key.length !== 32) {
    throw new TokenDecryptError('Windows DPAPI returned an unexpected key');
  }
  return key;
}

/** Cursor's Keychain item. The first read shows a macOS "allow access" prompt. */
async function loadMacKey(): Promise<Buffer> {
  let password: string;
  try {
    // Generous timeout: the Keychain prompt waits on the user.
    password = await run('/usr/bin/security', ['find-generic-password', '-s', 'Cursor Safe Storage', '-w'], undefined, 120_000);
  } catch {
    throw new TokenDecryptError('could not read "Cursor Safe Storage" from the Keychain (access denied?)');
  }
  if (!password) {
    throw new TokenDecryptError('"Cursor Safe Storage" Keychain item is empty');
  }
  return deriveMacKey(password);
}

const unsupported = (): Promise<Buffer> => Promise.reject(new TokenDecryptError(`not supported on ${process.platform} yet`));

export const cursorTokenDecoder: TokenDecoder =
  process.platform === 'win32'
    ? createTokenDecoder(decryptWindowsBlob, loadWindowsKey)
    : process.platform === 'darwin'
      ? createTokenDecoder(decryptMacBlob, loadMacKey)
      : createTokenDecoder(undefined, unsupported);

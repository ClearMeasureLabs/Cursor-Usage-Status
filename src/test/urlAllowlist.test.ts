import * as assert from 'assert';
import { assertSameOrigin, parseAllowedApiBase, usageUrl } from '../urlAllowlist';

describe('urlAllowlist', () => {
  it('rejects http', () => {
    const r = parseAllowedApiBase('http://api2.cursor.sh');
    assert.strictEqual(r.ok, false);
  });

  it('accepts https api base', () => {
    const r = parseAllowedApiBase('https://api2.cursor.sh');
    assert.strictEqual(r.ok, true);
    if (r.ok) {
      assert.strictEqual(r.origin, 'https://api2.cursor.sh');
    }
  });

  it('accepts enterprise-style https host', () => {
    const r = parseAllowedApiBase('https://usage.internal.example.com/path');
    assert.strictEqual(r.ok, true);
    if (r.ok) {
      assert.strictEqual(r.origin, 'https://usage.internal.example.com');
    }
  });

  it('usageUrl stays under same origin', () => {
    const r = parseAllowedApiBase('https://api2.cursor.sh');
    assert.strictEqual(r.ok, true);
    if (!r.ok) {
      return;
    }
    const u = usageUrl(r.baseUrl, '/auth/usage');
    assert.strictEqual(u.href, 'https://api2.cursor.sh/auth/usage');
    assert.doesNotThrow(() => assertSameOrigin(u, r));
  });

  it('assertSameOrigin rejects cross-origin', () => {
    const r = parseAllowedApiBase('https://api2.cursor.sh');
    assert.strictEqual(r.ok, true);
    if (!r.ok) {
      return;
    }
    const evil = new URL('https://evil.example/auth/usage');
    assert.throws(() => assertSameOrigin(evil, r));
  });
});

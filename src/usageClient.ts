import * as https from 'https';
import type { AllowedOriginResult } from './urlAllowlist';
import { assertSameOrigin, parseAllowedApiBase, usageUrl } from './urlAllowlist';

export type FetchResult =
  | { ok: true; status: number; json: unknown }
  | { ok: false; status?: number; error: string };

function httpsGet(url: URL, token: string, allowed: AllowedOriginResult & { ok: true }): Promise<FetchResult> {
  assertSameOrigin(url, allowed);
  return new Promise((resolve) => {
    const req = https.request(
      url,
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
          'User-Agent': 'cursor-usage-status',
        },
        timeout: 20_000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          const status = res.statusCode ?? 0;
          if (status < 200 || status >= 300) {
            resolve({ ok: false, status, error: `HTTP ${status}` });
            return;
          }
          try {
            const json = body.length ? JSON.parse(body) : {};
            resolve({ ok: true, status, json });
          } catch {
            resolve({ ok: false, status, error: 'Response was not valid JSON.' });
          }
        });
      }
    );
    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, error: 'Request timed out.' });
    });
    req.on('error', () => {
      resolve({ ok: false, error: 'Network error.' });
    });
    req.end();
  });
}

function httpsPostJson(
  url: URL,
  token: string,
  body: unknown,
  allowed: AllowedOriginResult & { ok: true }
): Promise<FetchResult> {
  assertSameOrigin(url, allowed);
  const payload = JSON.stringify(body ?? {});
  return new Promise((resolve) => {
    const req = https.request(
      url,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'Connect-Protocol-Version': '1',
          'User-Agent': 'cursor-usage-status',
        },
        timeout: 20_000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
        res.on('end', () => {
          const resBody = Buffer.concat(chunks).toString('utf8');
          const status = res.statusCode ?? 0;
          if (status < 200 || status >= 300) {
            resolve({ ok: false, status, error: `HTTP ${status}` });
            return;
          }
          try {
            const json = resBody.length ? JSON.parse(resBody) : {};
            resolve({ ok: true, status, json });
          } catch {
            resolve({ ok: false, status, error: 'Response was not valid JSON.' });
          }
        });
      }
    );
    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, error: 'Request timed out.' });
    });
    req.on('error', () => {
      resolve({ ok: false, error: 'Network error.' });
    });
    req.write(payload);
    req.end();
  });
}

export async function fetchCursorUsage(
  apiBaseUrl: string,
  token: string
): Promise<{
  auth: FetchResult;
  summary: FetchResult;
  dashboard: FetchResult;
  allowed: AllowedOriginResult & { ok: true };
}> {
  const allowed = parseAllowedApiBase(apiBaseUrl);
  if (!allowed.ok) {
    throw new Error(allowed.reason);
  }
  const authUrl = usageUrl(allowed.baseUrl, '/auth/usage');
  const summaryUrl = usageUrl(allowed.baseUrl, '/api/usage/summary');
  const dashboardUrl = usageUrl(allowed.baseUrl, '/aiserver.v1.DashboardService/GetCurrentPeriodUsage');
  const [auth, summary, dashboard] = await Promise.all([
    httpsGet(authUrl, token, allowed),
    httpsGet(summaryUrl, token, allowed),
    httpsPostJson(dashboardUrl, token, {}, allowed),
  ]);
  return { auth, summary, dashboard, allowed };
}

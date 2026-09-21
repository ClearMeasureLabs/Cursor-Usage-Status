import * as https from 'https';
import type { IncomingMessage } from 'http';
import type { AllowedOriginResult } from './urlAllowlist';
import { assertSameOrigin, parseAllowedApiBase, usageUrl } from './urlAllowlist';
import { parseAuthUsage, resolvePeriodStartMs } from './usageModel';

export type FetchResult =
  | { ok: true; status: number; json: unknown }
  | { ok: false; status?: number; error: string };

const DASHBOARD = '/aiserver.v1.DashboardService';

function readResponse(res: IncomingMessage, resolve: (r: FetchResult) => void): void {
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
      resolve({ ok: true, status, json: body.length ? JSON.parse(body) : {} });
    } catch {
      resolve({ ok: false, status, error: 'Response was not valid JSON.' });
    }
  });
}

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
      (res) => readResponse(res, resolve)
    );
    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, error: 'Request timed out.' });
    });
    req.on('error', () => resolve({ ok: false, error: 'Network error.' }));
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
      (res) => readResponse(res, resolve)
    );
    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, error: 'Request timed out.' });
    });
    req.on('error', () => resolve({ ok: false, error: 'Network error.' }));
    req.write(payload);
    req.end();
  });
}

export type UsageFetch = {
  auth: FetchResult;
  hardLimit: FetchResult;
  aggregated: FetchResult;
  allowed: AllowedOriginResult & { ok: true };
};

/**
 * Two round trips: /auth/usage and GetHardLimit run together, then the resolved cycle
 * start bounds the GetAggregatedUsageEvents query.
 *
 * The date range is sent explicitly rather than relying on the server empty-body default.
 * That default currently resolves to the active cycle, but it is undocumented and this API
 * has already deleted one route and emptied another out from under this extension.
 */
export async function fetchCursorUsage(
  apiBaseUrl: string,
  token: string,
  teamId: number | null,
  now: Date = new Date()
): Promise<UsageFetch> {
  const allowed = parseAllowedApiBase(apiBaseUrl);
  if (!allowed.ok) {
    throw new Error(allowed.reason);
  }

  const [auth, hardLimit] = await Promise.all([
    httpsGet(usageUrl(allowed.baseUrl, '/auth/usage'), token, allowed),
    httpsPostJson(
      usageUrl(allowed.baseUrl, DASHBOARD + '/GetHardLimit'),
      token,
      teamId === null ? {} : { teamId },
      allowed
    ),
  ]);

  const periodStart = auth.ok ? parseAuthUsage(auth.json).periodStart : undefined;
  const startMs = resolvePeriodStartMs(periodStart, now);
  const aggregated = await httpsPostJson(
    usageUrl(allowed.baseUrl, DASHBOARD + '/GetAggregatedUsageEvents'),
    token,
    { startDate: String(startMs), endDate: String(now.getTime()) },
    allowed
  );

  return { auth, hardLimit, aggregated, allowed };
}

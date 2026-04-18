/**
 * Ensures usage requests only go to the user-configured HTTPS origin.
 */

export type AllowedOriginResult =
  | { ok: true; origin: string; baseUrl: URL }
  | { ok: false; reason: string };

export function parseAllowedApiBase(apiBaseUrl: string): AllowedOriginResult {
  const trimmed = apiBaseUrl.trim();
  if (!trimmed) {
    return { ok: false, reason: 'API base URL is empty.' };
  }
  let u: URL;
  try {
    u = new URL(trimmed);
  } catch {
    return { ok: false, reason: 'API base URL is not a valid URL.' };
  }
  if (u.protocol !== 'https:') {
    return { ok: false, reason: 'API base URL must use https.' };
  }
  if (!u.hostname) {
    return { ok: false, reason: 'API base URL must include a hostname.' };
  }
  return { ok: true, origin: u.origin, baseUrl: u };
}

export function usageUrl(base: URL, pathname: string): URL {
  const p = pathname.startsWith('/') ? pathname : `/${pathname}`;
  return new URL(p, base);
}

export function assertSameOrigin(requestUrl: URL, allowed: AllowedOriginResult & { ok: true }): void {
  if (requestUrl.origin !== allowed.origin) {
    throw new Error('Request URL origin does not match configured API base.');
  }
}

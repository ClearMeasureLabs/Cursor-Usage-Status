export type IncludedBucket = {
  modelKey: string;
  used: number;
  limit: number;
  /**
   * `cents` = USD cents from Dashboard `planUsage` (Team / Pro / Ultra spend toward included allowance).
   * `requests` = monthly model request counts from `/auth/usage` (typical Enterprise shape).
   */
  valueKind?: 'cents' | 'requests';
};

export type OnDemandSummary = {
  spentDisplay?: string;
  limitDisplay?: string;
  /** Raw hints for tooltip when structure is unknown */
  extraLines?: string[];
};

export type NormalizedUsage = {
  periodStart?: string;
  included?: IncludedBucket;
  /** Optional token-related fields if API returns them */
  tokenHints?: string[];
  onDemand?: OnDemandSummary;
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function num(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) {
    return v;
  }
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/** Top-level / nested keys that are not per-model usage buckets. */
const USAGE_META_KEYS = new Set([
  'startOfMonth',
  'monthlyInvoice',
  'billingCycle',
  'periodStart',
  'cycleStart',
  'billingCycleStart',
  'subscription',
  'plan',
  'user',
  'team',
  'organization',
  'metadata',
  'error',
  'message',
]);

/**
 * Derive used + limit from one model object (requests, tokens, or remaining + used).
 * Team and enterprise responses use different field names; some plans only expose token tallies.
 */
function extractUsedLimit(val: Record<string, unknown>): { used: number; limit: number } | undefined {
  const nr = num(val.numRequests) ?? num(val.used) ?? num(val.requests);
  const mr =
    num(val.maxRequestUsage) ?? num(val.limit) ?? num(val.maxRequests) ?? num(val.requestLimit);
  if (nr !== undefined && mr !== undefined) {
    return { used: nr, limit: mr };
  }
  const remReq = num(val.remainingRequests) ?? num(val.requestsRemaining) ?? num(val.requestsLeft);
  if (nr !== undefined && remReq !== undefined) {
    return { used: nr, limit: nr + remReq };
  }

  const nt = num(val.numTokens) ?? num(val.totalTokens) ?? num(val.tokens) ?? num(val.inputTokens);
  const mt =
    num(val.maxTokenUsage) ??
    num(val.maxTokens) ??
    num(val.tokenLimit) ??
    num(val.includedTokens) ??
    num(val.tokenQuota) ??
    num(val.includedTokenLimit);
  if (nt !== undefined && mt !== undefined) {
    return { used: nt, limit: mt };
  }
  const remTok = num(val.remainingTokens) ?? num(val.tokensRemaining) ?? num(val.tokensLeft);
  if (nt !== undefined && remTok !== undefined) {
    return { used: nt, limit: nt + remTok };
  }

  return undefined;
}

/**
 * Collect model buckets from flat or nested `/auth/usage`-style JSON (walks a few levels deep).
 */
function collectIncludedBucketsDeep(root: Record<string, unknown>, maxDepth = 3): IncludedBucket[] {
  const out: IncludedBucket[] = [];
  const seen = new Set<string>();

  const walk = (obj: Record<string, unknown>, prefix: string, depth: number) => {
    for (const [key, val] of Object.entries(obj)) {
      if (USAGE_META_KEYS.has(key)) {
        continue;
      }
      if (!isRecord(val)) {
        continue;
      }
      const path = prefix ? `${prefix}.${key}` : key;
      const pair = extractUsedLimit(val);
      if (pair) {
        if (!seen.has(path)) {
          seen.add(path);
          out.push({ modelKey: path, used: pair.used, limit: pair.limit });
        }
      } else if (depth < maxDepth) {
        walk(val, path, depth + 1);
      }
    }
  };

  walk(root, '', 0);
  return out;
}

function pickBucket(buckets: IncludedBucket[], preferredKey: string): IncludedBucket | undefined {
  if (buckets.length === 0) {
    return undefined;
  }
  const exact = buckets.find((b) => b.modelKey === preferredKey);
  if (exact) {
    return exact;
  }
  const child = buckets.find((b) => b.modelKey.startsWith(preferredKey + '.'));
  if (child) {
    return child;
  }
  const suffix = buckets.find((b) => b.modelKey.endsWith('.' + preferredKey));
  if (suffix) {
    return suffix;
  }
  return buckets[0];
}

function collectTokenHints(root: Record<string, unknown>): string[] {
  const hints: string[] = [];
  const scan = (obj: Record<string, unknown>, prefix: string) => {
    for (const [k, v] of Object.entries(obj)) {
      const lk = k.toLowerCase();
      if (lk.includes('token') && (typeof v === 'number' || typeof v === 'string')) {
        hints.push(`${prefix}${k}: ${String(v)}`);
      }
      if (isRecord(v)) {
        scan(v, `${prefix}${k}.`);
      }
    }
  };
  scan(root, '');
  return hints.slice(0, 12);
}

function harvestUsageFromRoot(json: Record<string, unknown>, preferredModelKey: string): NormalizedUsage {
  const periodStart =
    str(json.startOfMonth) ?? str(json.periodStart) ?? str(json.cycleStart) ?? str(json.billingCycleStart);
  const buckets = collectIncludedBucketsDeep(json);
  const included = pickBucket(buckets, preferredModelKey);
  const tokenHints = collectTokenHints(json);
  return {
    periodStart,
    included,
    tokenHints: tokenHints.length > 0 ? tokenHints : undefined,
  };
}

/**
 * Parse Cursor `/auth/usage` style JSON.
 */
export function parseAuthUsage(json: unknown, preferredModelKey: string): NormalizedUsage {
  if (!isRecord(json)) {
    return {};
  }
  return harvestUsageFromRoot(json, preferredModelKey);
}

/**
 * Best-effort parse for `/api/usage/summary` or similar blobs.
 * Team plans sometimes expose quota only here or use token fields; we reuse the same bucket rules as `/auth/usage`.
 */
export function parseUsageSummary(json: unknown, preferredModelKey: string): NormalizedUsage {
  if (!isRecord(json)) {
    return {};
  }
  const harvested = harvestUsageFromRoot(json, preferredModelKey);
  const lines: string[] = [];
  const spent =
    str(json.onDemandSpend) ??
    str(json.onDemandSpent) ??
    (json.totalSpend !== undefined ? String(json.totalSpend) : undefined);
  const limit = str(json.onDemandLimit) ?? str(json.spendLimit);
  if (spent) {
    lines.push(`On-demand spend (raw): ${spent}`);
  }
  if (limit) {
    lines.push(`On-demand limit (raw): ${limit}`);
  }
  let onDemand = harvested.onDemand;
  if (spent || limit) {
    onDemand = {
      spentDisplay: spent,
      limitDisplay: limit,
      extraLines: lines.length > 0 ? lines : undefined,
    };
  }
  const tokenHints = [...(harvested.tokenHints ?? []), ...collectTokenHints(json)];
  const uniqueHints = [...new Set(tokenHints)];
  return {
    periodStart: harvested.periodStart,
    included: harvested.included,
    onDemand,
    tokenHints: uniqueHints.length > 0 ? uniqueHints : undefined,
  };
}

export function mergeUsage(auth: NormalizedUsage, summary: NormalizedUsage): NormalizedUsage {
  const tokenHints = [...(auth.tokenHints ?? []), ...(summary.tokenHints ?? [])];
  const unique = [...new Set(tokenHints)];
  return {
    periodStart: auth.periodStart ?? summary.periodStart,
    included: auth.included ?? summary.included,
    onDemand: summary.onDemand ?? auth.onDemand,
    tokenHints: unique.length > 0 ? unique : undefined,
  };
}

/**
 * Connect RPC `GetCurrentPeriodUsage` — Team/Pro/Ultra use `planUsage` (USD cents), not `/auth/usage` buckets.
 * @see https://github.com/robinebers/openusage/blob/main/docs/providers/cursor.md
 */
export function parseDashboardPeriodUsage(json: unknown): NormalizedUsage {
  if (!isRecord(json)) {
    return {};
  }
  const pu = json.planUsage;
  if (!isRecord(pu)) {
    return {};
  }
  const limit = num(pu.limit);
  const remaining = num(pu.remaining);
  const includedSpend = num(pu.includedSpend);
  const totalSpend = num(pu.totalSpend);

  let used: number | undefined;
  if (includedSpend !== undefined) {
    used = includedSpend;
  } else if (limit !== undefined && remaining !== undefined) {
    used = Math.max(0, limit - remaining);
  } else if (totalSpend !== undefined) {
    used = totalSpend;
  }

  let periodStart: string | undefined;
  const cycleStart = str(json.billingCycleStart);
  if (cycleStart) {
    const ms = Number(cycleStart);
    if (Number.isFinite(ms)) {
      try {
        periodStart = new Date(ms).toISOString();
      } catch {
        periodStart = cycleStart;
      }
    } else {
      periodStart = cycleStart;
    }
  }

  const tokenHints = collectTokenHints(json);

  if (limit === undefined || !(limit > 0) || used === undefined) {
    return {
      periodStart,
      tokenHints: tokenHints.length > 0 ? tokenHints : undefined,
    };
  }

  const onDemand = extractSpendLimitOnDemand(json);

  return {
    periodStart,
    included: { modelKey: 'planUsage', used, limit, valueKind: 'cents' },
    onDemand,
    tokenHints: tokenHints.length > 0 ? tokenHints : undefined,
  };
}

function extractSpendLimitOnDemand(json: Record<string, unknown>): OnDemandSummary | undefined {
  const sl = json.spendLimitUsage;
  if (!isRecord(sl)) {
    return undefined;
  }
  const pooledLimit = num(sl.pooledLimit);
  const pooledUsed = num(sl.pooledUsed);
  const individualLimit = num(sl.individualLimit);
  const individualUsed = num(sl.individualUsed);
  const limitType = str(sl.limitType);
  const lines: string[] = [];
  if (pooledLimit !== undefined && pooledLimit > 0) {
    lines.push(
      `Team pool (cents): used ${pooledUsed ?? 0} / ${pooledLimit} (remaining ${num(sl.pooledRemaining) ?? '—'})`
    );
  }
  if (individualLimit !== undefined && individualLimit > 0) {
    lines.push(
      `Individual cap (cents): used ${individualUsed ?? 0} / ${individualLimit} (remaining ${num(sl.individualRemaining) ?? '—'})`
    );
  }
  if (lines.length === 0) {
    return undefined;
  }
  return { extraLines: lines, limitDisplay: limitType };
}

/**
 * Overlay Dashboard-derived included allowance (authoritative for Team vs legacy GET /auth/usage).
 */
export function mergeDashboardPriority(base: NormalizedUsage, dashboard: NormalizedUsage): NormalizedUsage {
  const tokenHints = [...(base.tokenHints ?? []), ...(dashboard.tokenHints ?? [])];
  const unique = [...new Set(tokenHints)];
  return {
    periodStart: dashboard.periodStart ?? base.periodStart,
    included: dashboard.included ?? base.included,
    onDemand: dashboard.onDemand ?? base.onDemand,
    tokenHints: unique.length > 0 ? unique : undefined,
  };
}

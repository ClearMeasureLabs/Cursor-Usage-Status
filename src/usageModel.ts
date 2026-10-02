/**
 * Cursor moved from request quotas to token-based spend pricing (rolled out 2026-08-24).
 *
 * The old sources are gone: `/api/usage/summary` returns 404, `/auth/usage` reports
 * `maxRequestUsage: null` / `maxTokenUsage: null`, and `GetCurrentPeriodUsage` no longer
 * returns `planUsage`. Spend now comes from `GetAggregatedUsageEvents`. The per-user limit
 * comes from `/auth/usage-summary` (the payload the Usage page renders, including per-member
 * overrides), with `GetHardLimit`'s team-default cap as the fallback.
 */

export type ModelSpend = {
  /** `modelIntent`, e.g. `cursor-grok-4.6-high`. */
  model: string;
  /** Chargeable cents. Absent when the model ran entirely on free credits. */
  cents?: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
};

export type TokenTotals = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
};

export type LimitSource = 'summary' | 'team' | 'manual';

/** Last limit read from a successful usage summary, keyed by the cycle it belongs to. */
export type SummaryLimitCache = { periodStart: string; limitCents: number };

export type NormalizedUsage = {
  /** ISO timestamp for the start of the current billing cycle. */
  periodStart?: string;
  /** ISO timestamp for the end of the current billing cycle. */
  periodEnd?: string;
  /** Chargeable spend this cycle, in USD cents. Fractional; free credits excluded. */
  spentCents?: number;
  /** Per-user monthly cap in USD cents, when one is known. */
  limitCents?: number;
  limitSource?: LimitSource;
  /** True when the limit was carried over because this refresh's usage summary failed. */
  limitIsLastGood?: boolean;
  /** Per-model breakdown, highest spend first. */
  models?: ModelSpend[];
  totals?: TokenTotals;
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Token counts arrive as strings (`"130810"`); cents arrive as numbers. */
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

/**
 * `GET /auth/usage` — every request/token bucket now reports null, so only the cycle
 * boundaries are still worth reading.
 */
export function parseAuthUsage(json: unknown): { periodStart?: string; periodEnd?: string } {
  if (!isRecord(json)) {
    return {};
  }
  const periodStart =
    str(json.startOfMonth) ?? str(json.periodStart) ?? str(json.cycleStart) ?? str(json.billingCycleStart);
  const periodEnd =
    str(json.endOfMonth) ?? str(json.periodEnd) ?? str(json.cycleEnd) ?? str(json.billingCycleEnd);
  return { periodStart, periodEnd };
}

/**
 * Resolve the cycle window to query. Falls back to the first of the current UTC month
 * when `/auth/usage` is unavailable — cycles are not always calendar-aligned (the
 * 2026-08-24 pricing change produced a short Aug 24 - Sep 1 cycle), so this is a
 * fallback rather than a rule.
 */
export function resolvePeriodStartMs(periodStart: string | undefined, now: Date): number {
  if (periodStart) {
    const trimmed = periodStart.trim();
    const parsed = /^-?\d+$/.test(trimmed) ? Number(trimmed) : Date.parse(trimmed);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
}

/**
 * `GetHardLimit` — `perUserMonthlyLimitDollars` is only returned when a `teamId` is sent.
 * `hardLimit` is the team-wide total and is deliberately ignored.
 */
export function parseHardLimit(json: unknown): { limitCents?: number } {
  if (!isRecord(json)) {
    return {};
  }
  const dollars = num(json.perUserMonthlyLimitDollars);
  if (dollars === undefined || !(dollars > 0)) {
    return {};
  }
  return { limitCents: dollars * 100 };
}

/**
 * `GET /auth/usage-summary` — `individualUsage.overall.limit` is the per-user limit the Usage
 * page shows, in cents, including any per-member override of the team default.
 * `teamUsage` is the team-wide pool and is deliberately ignored.
 */
export function parseUsageSummary(json: unknown): { isUnlimited: boolean; limitCents?: number } {
  if (!isRecord(json)) {
    return { isUnlimited: false };
  }
  const isUnlimited = json.isUnlimited === true;
  const overall = isRecord(json.individualUsage) ? json.individualUsage.overall : undefined;
  if (!isRecord(overall) || overall.enabled === false) {
    return { isUnlimited };
  }
  const limit = num(overall.limit);
  return limit !== undefined && limit > 0 ? { isUnlimited, limitCents: limit } : { isUnlimited };
}

/**
 * `GetAggregatedUsageEvents` — `totalCostCents` is the sum of each event's `chargedCents`,
 * i.e. already net of any enterprise discount and already excluding free-credit events.
 * Free-credit models still appear in `aggregations` with token counts but no `totalCents`.
 *
 * Connect serializes proto3 defaults by omitting them, so a cycle with no chargeable spend
 * yet (e.g. just after the reset) comes back as `{}`. A missing `totalCostCents` on a
 * successful response therefore means zero, not unknown.
 */
export function parseAggregatedUsageEvents(json: unknown): {
  spentCents?: number;
  models?: ModelSpend[];
  totals?: TokenTotals;
} {
  if (!isRecord(json)) {
    return {};
  }

  const models: ModelSpend[] = [];
  const raw = json.aggregations;
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      if (!isRecord(entry)) {
        continue;
      }
      const model = str(entry.modelIntent);
      if (!model) {
        continue;
      }
      models.push({
        model,
        cents: num(entry.totalCents),
        inputTokens: num(entry.inputTokens) ?? 0,
        outputTokens: num(entry.outputTokens) ?? 0,
        cacheReadTokens: num(entry.cacheReadTokens) ?? 0,
      });
    }
  }
  models.sort((a, b) => (b.cents ?? -1) - (a.cents ?? -1));

  const spentCents = num(json.totalCostCents) ?? 0;
  const inputTokens = num(json.totalInputTokens);
  const outputTokens = num(json.totalOutputTokens);
  const cacheReadTokens = num(json.totalCacheReadTokens);
  const totals =
    inputTokens !== undefined || outputTokens !== undefined || cacheReadTokens !== undefined
      ? {
          inputTokens: inputTokens ?? 0,
          outputTokens: outputTokens ?? 0,
          cacheReadTokens: cacheReadTokens ?? 0,
        }
      : undefined;

  return {
    spentCents,
    models: models.length > 0 ? models : undefined,
    totals,
  };
}

/**
 * Combine the sources. The limit is resolved in order, recomputed on every refresh:
 *
 * 1. `manualLimitDollars`, when set — an explicit setting beats anything Cursor reports.
 * 2. A successful usage summary: `isUnlimited` means no limit at all; otherwise its
 *    per-user limit, when enabled and positive.
 * 3. When the summary call failed (`summary` undefined), the last good summary limit from
 *    the same cycle, so a transient error does not flip the bar back to the team default.
 * 4. `GetHardLimit`'s per-user team default.
 *
 * There is deliberately no max across sources: a lowered override must win over a higher
 * team default. `summaryCache` is what the caller should remember for the next refresh.
 */
export function buildUsage(args: {
  auth: { periodStart?: string; periodEnd?: string };
  hardLimit: { limitCents?: number };
  /** Undefined when the usage-summary request failed. */
  summary?: { isUnlimited: boolean; limitCents?: number };
  lastSummaryLimit?: SummaryLimitCache;
  aggregated: { spentCents?: number; models?: ModelSpend[]; totals?: TokenTotals };
  manualLimitDollars?: number;
}): { usage: NormalizedUsage; summaryCache?: SummaryLimitCache } {
  const { auth, hardLimit, summary, lastSummaryLimit, aggregated, manualLimitDollars } = args;

  const lastGood =
    lastSummaryLimit && auth.periodStart !== undefined && lastSummaryLimit.periodStart === auth.periodStart
      ? lastSummaryLimit
      : undefined;
  let summaryCache: SummaryLimitCache | undefined;
  if (summary === undefined) {
    summaryCache = lastGood;
  } else if (!summary.isUnlimited && summary.limitCents !== undefined && auth.periodStart !== undefined) {
    summaryCache = { periodStart: auth.periodStart, limitCents: summary.limitCents };
  }

  let limitCents: number | undefined;
  let limitSource: LimitSource | undefined;
  let limitIsLastGood = false;
  if (manualLimitDollars !== undefined && manualLimitDollars > 0) {
    limitCents = manualLimitDollars * 100;
    limitSource = 'manual';
  } else if (summary?.isUnlimited) {
    // No cap: show spend only rather than falling through to the team default.
  } else if (summary?.limitCents !== undefined) {
    limitCents = summary.limitCents;
    limitSource = 'summary';
  } else if (summary === undefined && lastGood) {
    limitCents = lastGood.limitCents;
    limitSource = 'summary';
    limitIsLastGood = true;
  } else if (hardLimit.limitCents !== undefined) {
    limitCents = hardLimit.limitCents;
    limitSource = 'team';
  }

  return {
    usage: {
      periodStart: auth.periodStart,
      periodEnd: auth.periodEnd,
      spentCents: aggregated.spentCents,
      limitCents,
      limitSource,
      limitIsLastGood: limitIsLastGood || undefined,
      models: aggregated.models,
      totals: aggregated.totals,
    },
    summaryCache,
  };
}

/** Remaining allowance in cents, or undefined when no limit is known. Never negative. */
export function remainingCents(usage: NormalizedUsage): number | undefined {
  if (usage.limitCents === undefined || usage.spentCents === undefined) {
    return undefined;
  }
  return Math.max(0, usage.limitCents - usage.spentCents);
}

/** Spend beyond the cap in cents. Zero when inside the cap or when no limit is known. */
export function overageCents(usage: NormalizedUsage): number {
  if (usage.limitCents === undefined || usage.spentCents === undefined) {
    return 0;
  }
  return Math.max(0, usage.spentCents - usage.limitCents);
}

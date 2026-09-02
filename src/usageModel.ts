/**
 * Cursor moved from request quotas to token-based spend pricing (rolled out 2026-08-24).
 *
 * The old sources are gone: `/api/usage/summary` returns 404, `/auth/usage` reports
 * `maxRequestUsage: null` / `maxTokenUsage: null`, and `GetCurrentPeriodUsage` no longer
 * returns `planUsage`. Spend now comes from `GetAggregatedUsageEvents` and the per-user
 * cap from `GetHardLimit`.
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

export type LimitSource = 'team' | 'manual';

export type NormalizedUsage = {
  /** ISO timestamp for the start of the current billing cycle. */
  periodStart?: string;
  /** Chargeable spend this cycle, in USD cents. Fractional; free credits excluded. */
  spentCents?: number;
  /** Per-user monthly cap in USD cents, when one is known. */
  limitCents?: number;
  limitSource?: LimitSource;
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
 * `GET /auth/usage` — every request/token bucket now reports null, so the only field
 * still worth reading is the cycle start.
 */
export function parseAuthUsage(json: unknown): { periodStart?: string } {
  if (!isRecord(json)) {
    return {};
  }
  const periodStart =
    str(json.startOfMonth) ?? str(json.periodStart) ?? str(json.cycleStart) ?? str(json.billingCycleStart);
  return { periodStart };
}

/**
 * Resolve the cycle window to query. Falls back to the first of the current UTC month
 * when `/auth/usage` is unavailable — cycles are not always calendar-aligned (the
 * 2026-08-24 pricing change produced a short Aug 24 - Sep 1 cycle), so this is a
 * fallback rather than a rule.
 */
export function resolvePeriodStartMs(periodStart: string | undefined, now: Date): number {
  if (periodStart) {
    const parsed = Date.parse(periodStart);
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
 * `GetAggregatedUsageEvents` — `totalCostCents` is the sum of each event's `chargedCents`,
 * i.e. already net of any enterprise discount and already excluding free-credit events.
 * Free-credit models still appear in `aggregations` with token counts but no `totalCents`.
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

  const spentCents = num(json.totalCostCents);
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
 * Combine the three sources. A manual limit is only consulted when the team cap is absent,
 * which is the case for accounts with no `teamId` (individual / Pro).
 */
export function buildUsage(args: {
  auth: { periodStart?: string };
  hardLimit: { limitCents?: number };
  aggregated: { spentCents?: number; models?: ModelSpend[]; totals?: TokenTotals };
  manualLimitDollars?: number;
}): NormalizedUsage {
  const { auth, hardLimit, aggregated, manualLimitDollars } = args;

  let limitCents = hardLimit.limitCents;
  let limitSource: LimitSource | undefined = limitCents !== undefined ? 'team' : undefined;
  if (limitCents === undefined && manualLimitDollars !== undefined && manualLimitDollars > 0) {
    limitCents = manualLimitDollars * 100;
    limitSource = 'manual';
  }

  return {
    periodStart: auth.periodStart,
    spentCents: aggregated.spentCents,
    limitCents,
    limitSource,
    models: aggregated.models,
    totals: aggregated.totals,
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

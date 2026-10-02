import * as assert from 'assert';
import {
  buildUsage,
  overageCents,
  parseAggregatedUsageEvents,
  parseAuthUsage,
  parseHardLimit,
  parseUsageSummary,
  remainingCents,
  resolvePeriodStartMs,
} from '../usageModel';

/**
 * Fixtures are trimmed captures of live api2.cursor.sh responses taken 2026-09-02,
 * after the token-pricing rollout.
 */
const AUTH_USAGE = {
  'gpt-4': {
    numRequests: 0,
    numRequestsTotal: 0,
    numTokens: 0,
    maxTokenUsage: null,
    maxRequestUsage: null,
  },
  startOfMonth: '2026-09-01T00:00:00.000Z',
};

const HARD_LIMIT_TEAM = { hardLimit: 16500, perUserMonthlyLimitDollars: 75 };
const HARD_LIMIT_NO_TEAM = { hardLimit: 16500 };

/**
 * `GET /auth/usage-summary`, captured 2026-09-30 from an account whose $75 team default had
 * a $150 per-member override. Display-message strings trimmed.
 */
const USAGE_SUMMARY = {
  billingCycleStart: '2026-09-01T00:00:00.000Z',
  billingCycleEnd: '2026-10-01T00:00:00.000Z',
  membershipType: 'enterprise',
  limitType: 'team',
  isUnlimited: false,
  individualUsage: { overall: { enabled: true, used: 6970, limit: 15000, remaining: 8030 } },
  teamUsage: { onDemand: { enabled: true, used: 0, limit: 1650000, remaining: 1650000 } },
};

function summaryWith(overall: Record<string, unknown>) {
  return { ...USAGE_SUMMARY, individualUsage: { overall } };
}

const AGGREGATED = {
  aggregations: [
    {
      modelIntent: 'cursor-grok-4.6-high',
      inputTokens: '130810',
      outputTokens: '12465',
      cacheReadTokens: '1023923',
      totalCents: 76.729779,
      tier: 1,
    },
    {
      // Ran entirely on a team credit grant: tokens, but no `totalCents` key at all.
      modelIntent: 'cursor-grok-4.5-high',
      inputTokens: '296601',
      outputTokens: '18669',
      cacheReadTokens: '889020',
      tier: 1,
    },
  ],
  totalInputTokens: '427411',
  totalOutputTokens: '31134',
  totalCacheReadTokens: '1912943',
  totalCostCents: 76.729779,
};

describe('usageModel', () => {
  describe('parseAuthUsage', () => {
    it('reads the cycle start even though every quota bucket is now null', () => {
      assert.strictEqual(parseAuthUsage(AUTH_USAGE).periodStart, '2026-09-01T00:00:00.000Z');
    });

    it('reads an API-reported cycle end', () => {
      assert.strictEqual(
        parseAuthUsage({ billingCycleEnd: '2026-09-20T00:00:00.000Z' }).periodEnd,
        '2026-09-20T00:00:00.000Z'
      );
    });

    it('returns nothing for a non-object body', () => {
      assert.deepStrictEqual(parseAuthUsage(null), {});
    });
  });

  describe('parseHardLimit', () => {
    it('converts the per-user dollar cap to cents', () => {
      assert.deepStrictEqual(parseHardLimit(HARD_LIMIT_TEAM), { limitCents: 7500 });
    });

    it('ignores the team-wide hardLimit when no per-user cap is present', () => {
      assert.deepStrictEqual(parseHardLimit(HARD_LIMIT_NO_TEAM), {});
    });
  });

  describe('parseAggregatedUsageEvents', () => {
    it('reads chargeable spend from totalCostCents', () => {
      assert.strictEqual(parseAggregatedUsageEvents(AGGREGATED).spentCents, 76.729779);
    });

    it('parses string token counts into numbers', () => {
      const totals = parseAggregatedUsageEvents(AGGREGATED).totals;
      assert.deepStrictEqual(totals, {
        inputTokens: 427411,
        outputTokens: 31134,
        cacheReadTokens: 1912943,
      });
    });

    it('leaves cents undefined for free-credit models rather than defaulting to zero', () => {
      const models = parseAggregatedUsageEvents(AGGREGATED).models ?? [];
      const free = models.find((m) => m.model === 'cursor-grok-4.5-high');
      assert.ok(free);
      assert.strictEqual(free.cents, undefined);
      assert.strictEqual(free.inputTokens, 296601);
    });

    it('sorts models by spend, with free models last', () => {
      const models = parseAggregatedUsageEvents(AGGREGATED).models ?? [];
      assert.deepStrictEqual(
        models.map((m) => m.model),
        ['cursor-grok-4.6-high', 'cursor-grok-4.5-high']
      );
    });

    it('reads an empty body as zero spend, since proto3 JSON omits zero values', () => {
      // Live response on 2026-10-01, minutes after the cycle reset.
      const u = parseAggregatedUsageEvents({});
      assert.strictEqual(u.spentCents, 0);
      assert.strictEqual(u.models, undefined);
      assert.strictEqual(u.totals, undefined);
    });

    it('reads omitted totalCostCents as zero when only free-credit models ran', () => {
      const u = parseAggregatedUsageEvents({ aggregations: [AGGREGATED.aggregations[1]] });
      assert.strictEqual(u.spentCents, 0);
      assert.strictEqual(u.models?.[0]?.cents, undefined);
    });

    it('still reports unknown spend for a non-object body', () => {
      assert.deepStrictEqual(parseAggregatedUsageEvents(null), {});
    });

    it('survives an empty aggregation list', () => {
      const u = parseAggregatedUsageEvents({ aggregations: [], totalCostCents: 0 });
      assert.strictEqual(u.spentCents, 0);
      assert.strictEqual(u.models, undefined);
    });
  });

  describe('resolvePeriodStartMs', () => {
    it('prefers the reported cycle start over the calendar month', () => {
      // The 2026-08-24 pricing change produced a short, non-calendar cycle.
      const ms = resolvePeriodStartMs('2026-08-24T00:00:00.000Z', new Date('2026-08-31T12:00:00Z'));
      assert.strictEqual(ms, Date.UTC(2026, 7, 24));
    });

    it('accepts an epoch-millisecond string from auth usage', () => {
      const ms = resolvePeriodStartMs('1755993600000', new Date('2026-08-31T12:00:00Z'));
      assert.strictEqual(ms, Date.UTC(2025, 7, 24));
    });

    it('falls back to the first of the current UTC month', () => {
      const ms = resolvePeriodStartMs(undefined, new Date('2026-09-02T00:42:00Z'));
      assert.strictEqual(ms, Date.UTC(2026, 8, 1));
    });
  });

  describe('buildUsage', () => {
    const base = {
      auth: parseAuthUsage(AUTH_USAGE),
      aggregated: parseAggregatedUsageEvents(AGGREGATED),
    };

    it('assembles the live dashboard figures', () => {
      const { usage: u } = buildUsage({ ...base, hardLimit: parseHardLimit(HARD_LIMIT_TEAM) });
      assert.strictEqual(u.spentCents, 76.729779);
      assert.strictEqual(u.limitCents, 7500);
      assert.strictEqual(u.limitSource, 'team');
      assert.strictEqual(u.periodStart, '2026-09-01T00:00:00.000Z');
    });

    it('retains an API-reported cycle end', () => {
      const { usage: u } = buildUsage({
        ...base,
        auth: parseAuthUsage({
          startOfMonth: '2026-09-01T00:00:00.000Z',
          billingCycleEnd: '2026-09-20T00:00:00.000Z',
        }),
        hardLimit: parseHardLimit(HARD_LIMIT_TEAM),
      });
      assert.strictEqual(u.periodEnd, '2026-09-20T00:00:00.000Z');
    });

    it('lets a manual override beat the team cap', () => {
      const { usage: u } = buildUsage({
        ...base,
        hardLimit: parseHardLimit(HARD_LIMIT_TEAM),
        manualLimitDollars: 20,
      });
      assert.strictEqual(u.limitCents, 2000);
      assert.strictEqual(u.limitSource, 'manual');
    });

    it('uses the manual override when the account reports no per-user cap', () => {
      const { usage: u } = buildUsage({
        ...base,
        hardLimit: parseHardLimit(HARD_LIMIT_NO_TEAM),
        manualLimitDollars: 20,
      });
      assert.strictEqual(u.limitCents, 2000);
      assert.strictEqual(u.limitSource, 'manual');
    });

    it('leaves the limit unset when there is neither a cap nor an override', () => {
      const { usage: u } = buildUsage({ ...base, hardLimit: parseHardLimit(HARD_LIMIT_NO_TEAM) });
      assert.strictEqual(u.limitCents, undefined);
      assert.strictEqual(u.limitSource, undefined);
      assert.strictEqual(u.spentCents, 76.729779);
    });
  });

  describe('buildUsage limit order', () => {
    const base = {
      auth: parseAuthUsage(AUTH_USAGE),
      aggregated: parseAggregatedUsageEvents(AGGREGATED),
      hardLimit: parseHardLimit(HARD_LIMIT_TEAM),
    };
    const SAME_CYCLE = { periodStart: '2026-09-01T00:00:00.000Z', limitCents: 15000 };

    it('prefers the usage-summary override over the team default', () => {
      const { usage: u, summaryCache } = buildUsage({ ...base, summary: parseUsageSummary(USAGE_SUMMARY) });
      assert.strictEqual(u.limitCents, 15000);
      assert.strictEqual(u.limitSource, 'summary');
      assert.strictEqual(u.limitIsLastGood, undefined);
      assert.strictEqual(u.spentCents, 76.729779, 'spend stays on aggregated events, not overall.used');
      assert.deepStrictEqual(summaryCache, SAME_CYCLE);
    });

    it('respects an override below the team default rather than taking the max', () => {
      const summary = parseUsageSummary(summaryWith({ enabled: true, used: 6970, limit: 5000 }));
      const { usage: u } = buildUsage({ ...base, summary });
      assert.strictEqual(u.limitCents, 5000);
      assert.strictEqual(u.limitSource, 'summary');
    });

    it('keeps the last good summary limit when the summary call fails in the same cycle', () => {
      const { usage: u, summaryCache } = buildUsage({ ...base, summary: undefined, lastSummaryLimit: SAME_CYCLE });
      assert.strictEqual(u.limitCents, 15000);
      assert.strictEqual(u.limitSource, 'summary');
      assert.strictEqual(u.limitIsLastGood, true);
      assert.deepStrictEqual(summaryCache, SAME_CYCLE);
    });

    it('drops a last good limit from a previous cycle and falls back to the team default', () => {
      const lastSummaryLimit = { periodStart: '2026-08-24T00:00:00.000Z', limitCents: 15000 };
      const { usage: u, summaryCache } = buildUsage({ ...base, summary: undefined, lastSummaryLimit });
      assert.strictEqual(u.limitCents, 7500);
      assert.strictEqual(u.limitSource, 'team');
      assert.strictEqual(u.limitIsLastGood, undefined);
      assert.strictEqual(summaryCache, undefined);
    });

    it('skips the last good limit when the summary succeeds with the limit disabled', () => {
      const summary = parseUsageSummary(summaryWith({ enabled: false, used: 0, limit: 15000 }));
      const { usage: u, summaryCache } = buildUsage({ ...base, summary, lastSummaryLimit: SAME_CYCLE });
      assert.strictEqual(u.limitCents, 7500);
      assert.strictEqual(u.limitSource, 'team');
      assert.strictEqual(summaryCache, undefined);
    });

    it('shows no limit for an unlimited account instead of the team default', () => {
      const summary = parseUsageSummary({ ...USAGE_SUMMARY, isUnlimited: true });
      const { usage: u, summaryCache } = buildUsage({ ...base, summary, lastSummaryLimit: SAME_CYCLE });
      assert.strictEqual(u.limitCents, undefined);
      assert.strictEqual(u.limitSource, undefined);
      assert.strictEqual(summaryCache, undefined);
    });

    it('lets a manual override beat the usage-summary limit', () => {
      const { usage: u, summaryCache } = buildUsage({
        ...base,
        summary: parseUsageSummary(USAGE_SUMMARY),
        manualLimitDollars: 100,
      });
      assert.strictEqual(u.limitCents, 10000);
      assert.strictEqual(u.limitSource, 'manual');
      assert.deepStrictEqual(summaryCache, SAME_CYCLE, 'the summary limit is still cached');
    });

    it('never uses team-wide totals as the per-user limit', () => {
      const summary = parseUsageSummary({ teamUsage: USAGE_SUMMARY.teamUsage });
      const { usage: u } = buildUsage({ ...base, hardLimit: parseHardLimit(HARD_LIMIT_NO_TEAM), summary });
      assert.strictEqual(u.limitCents, undefined);
      assert.strictEqual(u.limitSource, undefined);
    });
  });

  describe('parseUsageSummary', () => {
    it('reads the per-user limit in cents', () => {
      assert.deepStrictEqual(parseUsageSummary(USAGE_SUMMARY), { isUnlimited: false, limitCents: 15000 });
    });

    it('parses a limit sent as a string', () => {
      const parsed = parseUsageSummary(summaryWith({ enabled: true, used: '6970', limit: '15000' }));
      assert.strictEqual(parsed.limitCents, 15000);
    });

    it('treats a zero limit as absent', () => {
      assert.strictEqual(parseUsageSummary(summaryWith({ enabled: true, used: 0, limit: 0 })).limitCents, undefined);
    });

    it('returns no limit when individualUsage is missing', () => {
      assert.deepStrictEqual(parseUsageSummary({ isUnlimited: false }), { isUnlimited: false });
    });

    it('returns nothing for a non-object body', () => {
      assert.deepStrictEqual(parseUsageSummary(null), { isUnlimited: false });
      assert.deepStrictEqual(parseUsageSummary([USAGE_SUMMARY]), { isUnlimited: false });
    });
  });

  describe('remainingCents / overageCents', () => {
    it('reports remaining allowance inside the cap', () => {
      const u = { spentCents: 76.729779, limitCents: 7500 };
      assert.ok(Math.abs((remainingCents(u) ?? 0) - 7423.270221) < 1e-6);
      assert.strictEqual(overageCents(u), 0);
    });

    it('reports overage past the cap and never a negative remainder', () => {
      const u = { spentCents: 8740, limitCents: 7500 };
      assert.strictEqual(remainingCents(u), 0);
      assert.strictEqual(overageCents(u), 1240);
    });

    it('reports neither without a known limit', () => {
      assert.strictEqual(remainingCents({ spentCents: 100 }), undefined);
      assert.strictEqual(overageCents({ spentCents: 100 }), 0);
    });
  });
});

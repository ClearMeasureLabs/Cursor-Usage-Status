import * as assert from 'assert';
import {
  buildUsage,
  overageCents,
  parseAggregatedUsageEvents,
  parseAuthUsage,
  parseHardLimit,
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
      const u = buildUsage({ ...base, hardLimit: parseHardLimit(HARD_LIMIT_TEAM) });
      assert.strictEqual(u.spentCents, 76.729779);
      assert.strictEqual(u.limitCents, 7500);
      assert.strictEqual(u.limitSource, 'team');
      assert.strictEqual(u.periodStart, '2026-09-01T00:00:00.000Z');
    });

    it('prefers the team cap over a manual override', () => {
      const u = buildUsage({
        ...base,
        hardLimit: parseHardLimit(HARD_LIMIT_TEAM),
        manualLimitDollars: 20,
      });
      assert.strictEqual(u.limitCents, 7500);
      assert.strictEqual(u.limitSource, 'team');
    });

    it('uses the manual override when the account reports no per-user cap', () => {
      const u = buildUsage({
        ...base,
        hardLimit: parseHardLimit(HARD_LIMIT_NO_TEAM),
        manualLimitDollars: 20,
      });
      assert.strictEqual(u.limitCents, 2000);
      assert.strictEqual(u.limitSource, 'manual');
    });

    it('leaves the limit unset when there is neither a cap nor an override', () => {
      const u = buildUsage({ ...base, hardLimit: parseHardLimit(HARD_LIMIT_NO_TEAM) });
      assert.strictEqual(u.limitCents, undefined);
      assert.strictEqual(u.limitSource, undefined);
      assert.strictEqual(u.spentCents, 76.729779);
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

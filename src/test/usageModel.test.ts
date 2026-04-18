import * as assert from 'assert';
import { mergeDashboardPriority, mergeUsage, parseAuthUsage, parseDashboardPeriodUsage, parseUsageSummary } from '../usageModel';

describe('usageModel', () => {
  it('parses auth usage shape', () => {
    const json = {
      'gpt-4': { numRequests: 150, maxRequestUsage: 500 },
      startOfMonth: '2026-03-01T00:00:00.000Z',
    };
    const u = parseAuthUsage(json, 'gpt-4');
    assert.deepStrictEqual(u.included, { modelKey: 'gpt-4', used: 150, limit: 500 });
    assert.strictEqual(u.periodStart, '2026-03-01T00:00:00.000Z');
  });

  it('picks preferred model bucket when present', () => {
    const json = {
      'gpt-3.5-turbo': { numRequests: 1, maxRequestUsage: 10 },
      'gpt-4': { numRequests: 2, maxRequestUsage: 20 },
    };
    const u = parseAuthUsage(json, 'gpt-4');
    assert.deepStrictEqual(u.included, { modelKey: 'gpt-4', used: 2, limit: 20 });
  });

  it('falls back to first bucket when preferred missing', () => {
    const json = {
      'custom-model': { numRequests: 3, maxRequestUsage: 30 },
    };
    const u = parseAuthUsage(json, 'gpt-4');
    assert.deepStrictEqual(u.included, { modelKey: 'custom-model', used: 3, limit: 30 });
  });

  it('merges summary on-demand hints', () => {
    const auth = parseAuthUsage({ 'gpt-4': { numRequests: 1, maxRequestUsage: 10 } }, 'gpt-4');
    const summary = parseUsageSummary({ onDemandSpend: '$1.23', onDemandLimit: '$50' }, 'gpt-4');
    const merged = mergeUsage(auth, summary);
    assert.ok(merged.included);
    assert.ok(merged.onDemand?.spentDisplay);
  });

  it('parses token-based included quota (team-style)', () => {
    const json = {
      'gpt-4': { numTokens: 1000, maxTokenUsage: 1_000_000 },
      startOfMonth: '2026-03-01T00:00:00.000Z',
    };
    const u = parseAuthUsage(json, 'gpt-4');
    assert.deepStrictEqual(u.included, { modelKey: 'gpt-4', used: 1000, limit: 1_000_000 });
  });

  it('derives limit from remainingRequests when max is omitted', () => {
    const json = { 'gpt-4': { numRequests: 40, remainingRequests: 460 } };
    const u = parseAuthUsage(json, 'gpt-4');
    assert.deepStrictEqual(u.included, { modelKey: 'gpt-4', used: 40, limit: 500 });
  });

  it('reads nested model buckets', () => {
    const json = { 'gpt-4': { fast: { numRequests: 2, maxRequestUsage: 20 } } };
    const u = parseAuthUsage(json, 'gpt-4');
    assert.deepStrictEqual(u.included, { modelKey: 'gpt-4.fast', used: 2, limit: 20 });
  });

  it('fills included from summary when auth omits quota', () => {
    const auth = parseAuthUsage({ startOfMonth: '2026-01-01T00:00:00.000Z' }, 'gpt-4');
    const summary = parseUsageSummary({ 'gpt-4': { numRequests: 5, maxRequestUsage: 100 } }, 'gpt-4');
    const merged = mergeUsage(auth, summary);
    assert.deepStrictEqual(merged.included, { modelKey: 'gpt-4', used: 5, limit: 100 });
  });

  it('parses Connect RPC GetCurrentPeriodUsage (Team planUsage cents)', () => {
    const dash = {
      billingCycleStart: '1711200000000',
      planUsage: {
        totalSpend: 23222,
        includedSpend: 23222,
        bonusSpend: 0,
        remaining: 16778,
        limit: 40000,
      },
    };
    const u = parseDashboardPeriodUsage(dash);
    assert.deepStrictEqual(u.included, {
      modelKey: 'planUsage',
      used: 23222,
      limit: 40000,
      valueKind: 'cents',
    });
    assert.ok(u.periodStart?.includes('2024') || u.periodStart?.includes('2025') || u.periodStart?.includes('2026'));
  });

  it('dashboard overrides empty auth for Team', () => {
    const auth = parseAuthUsage({ 'gpt-4': { numTokens: 0 } }, 'gpt-4');
    const dash = parseDashboardPeriodUsage({
      planUsage: { includedSpend: 100, limit: 40000, remaining: 39900 },
    });
    const merged = mergeDashboardPriority(auth, dash);
    assert.strictEqual(merged.included?.valueKind, 'cents');
    assert.strictEqual(merged.included?.limit, 40000);
  });
});

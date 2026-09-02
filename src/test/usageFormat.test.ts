import * as assert from 'assert';
import { formatModelLine, formatPrimaryText, formatTokens, severityFor } from '../usageFormat';
import type { NormalizedUsage } from '../usageModel';

const LIVE: NormalizedUsage = { spentCents: 76.729779, limitCents: 7500, limitSource: 'team' };

describe('usageFormat', () => {
  describe('formatTokens', () => {
    it('abbreviates millions and thousands', () => {
      assert.strictEqual(formatTokens(1_023_923), '1.0M');
      assert.strictEqual(formatTokens(296_601), '297K');
      assert.strictEqual(formatTokens(942), '942');
    });
  });

  describe('formatPrimaryText', () => {
    it('shows remaining allowance by default', () => {
      assert.strictEqual(formatPrimaryText(LIVE, 'remaining'), '\u26A1 $74.23 left');
    });

    it('shows spend over limit as a fraction', () => {
      assert.strictEqual(formatPrimaryText(LIVE, 'fraction'), '\u26A1 $0.77/$75.00');
    });

    it('shows a bare remaining figure when compact', () => {
      assert.strictEqual(formatPrimaryText(LIVE, 'compact'), '\u26A1 $74.23');
    });

    it('names the overage instead of pinning at zero', () => {
      const over: NormalizedUsage = { spentCents: 8740, limitCents: 7500 };
      assert.strictEqual(formatPrimaryText(over, 'remaining'), '\u26A1 $12.40 over');
    });

    it('shows spend only when the account reports no per-user cap', () => {
      assert.strictEqual(formatPrimaryText({ spentCents: 468 }, 'remaining'), '\u26A1 $4.68 used');
    });

    it('falls back to unavailable when spend could not be read', () => {
      assert.strictEqual(formatPrimaryText({}, 'remaining'), 'Cursor Usage: unavailable');
    });
  });

  describe('formatModelLine', () => {
    it('labels free-credit models rather than printing $0.00', () => {
      const line = formatModelLine({
        model: 'cursor-grok-4.5-high',
        inputTokens: 296_601,
        outputTokens: 18_669,
        cacheReadTokens: 889_020,
      });
      assert.strictEqual(line, 'cursor-grok-4.5-high — free (297K in / 19K out)');
    });

    it('prints the cost for chargeable models', () => {
      const line = formatModelLine({
        model: 'cursor-grok-4.6-high',
        cents: 76.729779,
        inputTokens: 130_810,
        outputTokens: 12_465,
        cacheReadTokens: 1_023_923,
      });
      assert.strictEqual(line, 'cursor-grok-4.6-high — $0.77 (131K in / 12K out)');
    });
  });

  describe('severityFor', () => {
    it('stays quiet with most of the allowance left', () => {
      assert.strictEqual(severityFor(LIVE, 20, 10), 'none');
    });

    it('warns at or below the warning threshold', () => {
      assert.strictEqual(severityFor({ spentCents: 6000, limitCents: 7500 }, 20, 10), 'warning');
    });

    it('goes critical at or below the critical threshold', () => {
      assert.strictEqual(severityFor({ spentCents: 6800, limitCents: 7500 }, 20, 10), 'critical');
    });

    it('goes critical once over the limit', () => {
      assert.strictEqual(severityFor({ spentCents: 8740, limitCents: 7500 }, 20, 10), 'critical');
    });

    it('has no severity to report without a limit', () => {
      assert.strictEqual(severityFor({ spentCents: 468 }, 20, 10), 'none');
    });
  });
});

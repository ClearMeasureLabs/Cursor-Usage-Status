import * as assert from 'assert';
import {
  addMonthsClamped,
  buildOverageMessage,
  dismissFor,
  DISMISSED,
  formatShortDate,
  INITIAL_NOTIFY_STATE,
  nextNotification,
  periodIdOf,
  projectUsage,
  projectionLines,
  resolvePeriodEnd,
  STEP,
  type NotifyState,
  type UsageProjection,
} from '../usageProjection';

/** Sep 1 - Oct 1 2026: a 30-day cycle, matching the live billing period. */
const P_START = Date.UTC(2026, 8, 1);
const P_END = Date.UTC(2026, 9, 1);
const DAY = 86_400_000;
const LIMIT = 7500; // $75 in cents

/** `now` at a given fraction through the 30-day period. */
function at(fraction: number): Date {
  return new Date(P_START + (P_END - P_START) * fraction);
}

/**
 * Spend that lands exhaustion with `remaining` of the period left.
 * remainingFraction = 1 - elapsedFraction / spendFraction, so spend = elapsed / (1 - remaining).
 */
function spendFor(elapsedFraction: number, remainingFraction: number): number {
  return LIMIT * (elapsedFraction / (1 - remainingFraction));
}

describe('addMonthsClamped', () => {
  it('advances a normal month boundary', () => {
    assert.strictEqual(addMonthsClamped(Date.UTC(2026, 8, 1), 1), Date.UTC(2026, 9, 1));
  });

  it('clamps Jan 31 to Feb 28 in a non-leap year', () => {
    assert.strictEqual(addMonthsClamped(Date.UTC(2026, 0, 31), 1), Date.UTC(2026, 1, 28));
  });

  it('clamps Jan 31 to Feb 29 in a leap year', () => {
    assert.strictEqual(addMonthsClamped(Date.UTC(2028, 0, 31), 1), Date.UTC(2028, 1, 29));
  });

  it('rolls across a year boundary', () => {
    assert.strictEqual(addMonthsClamped(Date.UTC(2026, 11, 15), 1), Date.UTC(2027, 0, 15));
  });
});

describe('resolvePeriodEnd', () => {
  it('prefers an explicit API end over the calendar fallback', () => {
    const apiEnd = Date.UTC(2026, 8, 20);
    const { endMs } = resolvePeriodEnd('2026-09-01T00:00:00.000Z', apiEnd, at(0.5));
    assert.strictEqual(endMs, apiEnd);
  });

  it('ignores an API end that precedes the start', () => {
    const { endMs } = resolvePeriodEnd('2026-09-01T00:00:00.000Z', Date.UTC(2026, 7, 20), at(0.5));
    assert.strictEqual(endMs, P_END);
  });

  it('falls back to the current calendar month when no start is reported', () => {
    const { startMs, endMs } = resolvePeriodEnd(undefined, undefined, at(0.5));
    assert.strictEqual(startMs, P_START);
    assert.strictEqual(endMs, P_END);
  });

  it('accepts an epoch-millisecond string start', () => {
    // The value GetTeamSpend reports for subscriptionCycleStart.
    const { startMs, endMs } = resolvePeriodEnd('1788220800000', undefined, at(0.5));
    assert.strictEqual(startMs, P_START);
    assert.strictEqual(endMs, P_END);
  });
});

describe('projectUsage guards', () => {
  const base = { periodStart: P_START, now: at(0.5) };

  it('reports no-included when the bucket is missing', () => {
    assert.strictEqual(projectUsage({ ...base, spent: 4000 }).kind, 'no-included');
  });

  it('reports no-included when the limit is zero', () => {
    assert.strictEqual(projectUsage({ ...base, spent: 4000, limit: 0 }).kind, 'no-included');
  });

  it('reports no-period when the snapshot is from a closed period', () => {
    const p = projectUsage({ spent: 4000, limit: LIMIT, periodStart: P_START, now: new Date(P_END + DAY) });
    assert.strictEqual(p.kind, 'no-period');
  });

  it('suppresses on the elapsed floor even when plenty is spent', () => {
    const p = projectUsage({ spent: 5000, limit: LIMIT, periodStart: P_START, now: at(0.05) });
    assert.deepStrictEqual(p, { kind: 'too-early', reason: 'elapsed' });
  });

  it('suppresses on the spend floor even when most of the period has elapsed', () => {
    const p = projectUsage({ spent: 100, limit: LIMIT, periodStart: P_START, now: at(0.9) });
    assert.deepStrictEqual(p, { kind: 'too-early', reason: 'spend' });
  });

  it('treats zero usage as too-early rather than a zero-rate projection', () => {
    const p = projectUsage({ spent: 0, limit: LIMIT, periodStart: P_START, now: at(0.5) });
    assert.deepStrictEqual(p, { kind: 'too-early', reason: 'no-usage' });
  });
});

describe('projectUsage pace', () => {
  it('reports on-pace with step 0 for light usage', () => {
    // Half the period gone, a fifth of the allowance spent.
    const p = projectUsage({ spent: LIMIT * 0.2, limit: LIMIT, periodStart: P_START, now: at(0.5) });
    assert.strictEqual(p.kind, 'projected');
    assert.strictEqual(p.kind === 'projected' && p.step, STEP.ON_PACE);
  });

  it('escalates to step 1 when exhaustion lands just before the reset', () => {
    const p = projectUsage({
      spent: spendFor(0.5, 0.1),
      limit: LIMIT,
      periodStart: P_START,
      now: at(0.5),
    });
    assert.strictEqual(p.kind === 'projected' && p.step, STEP.EARLY);
  });

  it('escalates to step 2 when a quarter of the period would be left', () => {
    const p = projectUsage({
      spent: spendFor(0.25, 0.3),
      limit: LIMIT,
      periodStart: P_START,
      now: at(0.25),
    });
    assert.strictEqual(p.kind === 'projected' && p.step, STEP.QUARTER);
  });

  it('escalates to step 3 when half the period would be left', () => {
    const p = projectUsage({
      spent: spendFor(0.25, 0.6),
      limit: LIMIT,
      periodStart: P_START,
      now: at(0.25),
    });
    assert.strictEqual(p.kind === 'projected' && p.step, STEP.HALF);
  });

  it('projects against the calendar month when no start is reported', () => {
    const p = projectUsage({ spent: spendFor(0.5, 0.1), limit: LIMIT, now: at(0.5) });
    assert.strictEqual(p.kind, 'projected');
    if (p.kind === 'projected') {
      assert.strictEqual(p.periodStartMs, P_START);
      assert.strictEqual(p.periodEndMs, P_END);
      assert.strictEqual(p.step, STEP.EARLY);
    }
  });

  it('projects any allowance unit on the same code path', () => {
    // The old request-quota plans exercised this; the maths never depended on the unit.
    const cents = projectUsage({
      spent: spendFor(0.5, 0.1),
      limit: LIMIT,
      periodStart: P_START,
      now: at(0.5),
    });
    const requests = projectUsage({
      spent: 500 * (0.5 / 0.9),
      limit: 500,
      periodStart: P_START,
      now: at(0.5),
    });
    assert.strictEqual(cents.kind === 'projected' && cents.step, STEP.EARLY);
    assert.strictEqual(requests.kind === 'projected' && requests.step, STEP.EARLY);
  });

  it('honours an explicit API period end', () => {
    const apiEnd = Date.UTC(2026, 8, 20);
    const p = projectUsage({
      spent: 4000,
      limit: LIMIT,
      periodStart: P_START,
      periodEnd: apiEnd,
      now: at(0.25),
    });
    assert.strictEqual(p.kind === 'projected' && p.periodEndMs, apiEnd);
  });

  it('reports an exhausted allowance as already spent rather than forecast', () => {
    const p = projectUsage({ spent: LIMIT + 500, limit: LIMIT, periodStart: P_START, now: at(0.5) });
    assert.strictEqual(p.kind, 'projected');
    if (p.kind === 'projected') {
      assert.strictEqual(p.alreadyExhausted, true);
      assert.strictEqual(p.exhaustionMs, at(0.5).getTime());
      assert.strictEqual(p.step, STEP.HALF);
    }
  });
});

/** A projection with an explicit step, for driving the notification state machine. */
function projected(step: number, startMs = P_START, endMs = P_END): UsageProjection {
  return {
    kind: 'projected',
    step: step as 0 | 1 | 2 | 3,
    exhaustionMs: startMs + (endMs - startMs) * 0.6,
    periodStartMs: startMs,
    periodEndMs: endMs,
    remainingFractionAtExhaustion: 0.4,
    alreadyExhausted: false,
  };
}

describe('nextNotification', () => {
  const armed: NotifyState = { periodId: periodIdOf(P_START), notifiedStep: STEP.ON_PACE };

  it('fires on the first off-pace poll of a period', () => {
    const r = nextNotification(projected(STEP.EARLY), INITIAL_NOTIFY_STATE);
    assert.strictEqual(r.fire, true);
    assert.strictEqual(r.state.notifiedStep, STEP.EARLY);
    assert.strictEqual(r.state.periodId, periodIdOf(P_START));
  });

  it('stays silent when the step is unchanged', () => {
    const state: NotifyState = { ...armed, notifiedStep: STEP.EARLY };
    assert.strictEqual(nextNotification(projected(STEP.EARLY), state).fire, false);
  });

  it('fires again when the projection materially worsens', () => {
    const state: NotifyState = { ...armed, notifiedStep: STEP.EARLY };
    const r = nextNotification(projected(STEP.QUARTER), state);
    assert.strictEqual(r.fire, true);
    assert.strictEqual(r.state.notifiedStep, STEP.QUARTER);
  });

  it('keeps the high-water mark when the projection improves', () => {
    const state: NotifyState = { ...armed, notifiedStep: STEP.HALF };
    const r = nextNotification(projected(STEP.EARLY), state);
    assert.strictEqual(r.fire, false);
    assert.strictEqual(r.state.notifiedStep, STEP.HALF);
  });

  it('resets on a new billing period', () => {
    const previous: NotifyState = { periodId: periodIdOf(Date.UTC(2026, 7, 1)), notifiedStep: STEP.HALF };
    const r = nextNotification(projected(STEP.EARLY), previous);
    assert.strictEqual(r.fire, true);
    assert.strictEqual(r.state.notifiedStep, STEP.EARLY);
  });

  it('stays silent for the rest of the period once dismissed', () => {
    const dismissed = dismissFor(projected(STEP.EARLY), armed);
    assert.strictEqual(dismissed.notifiedStep, DISMISSED);
    assert.strictEqual(nextNotification(projected(STEP.HALF), dismissed).fire, false);
  });

  it('re-arms after a dismissed period ends', () => {
    const dismissed = dismissFor(projected(STEP.EARLY), armed);
    const nextPeriod = projected(STEP.EARLY, Date.UTC(2026, 9, 1), Date.UTC(2026, 10, 1));
    assert.strictEqual(nextNotification(nextPeriod, dismissed).fire, true);
  });

  it('never fires while on pace', () => {
    assert.strictEqual(nextNotification(projected(STEP.ON_PACE), INITIAL_NOTIFY_STATE).fire, false);
  });

  it('never fires when no projection is available', () => {
    for (const p of [
      { kind: 'no-included' } as const,
      { kind: 'no-period' } as const,
      { kind: 'too-early', reason: 'elapsed' } as const,
    ]) {
      assert.strictEqual(nextNotification(p, INITIAL_NOTIFY_STATE).fire, false);
    }
  });
});

describe('buildOverageMessage', () => {
  it('names the exhaustion date and how early it lands', () => {
    const exhaustion = Date.UTC(2026, 8, 18);
    const p: UsageProjection = {
      kind: 'projected',
      step: STEP.QUARTER,
      exhaustionMs: exhaustion,
      periodStartMs: P_START,
      periodEndMs: P_END,
      remainingFractionAtExhaustion: 13 / 30,
      alreadyExhausted: false,
    };
    const msg = buildOverageMessage(p, LIMIT);
    assert.ok(msg.includes(formatShortDate(exhaustion)), 'names the exhaustion date');
    assert.ok(msg.includes(formatShortDate(P_END)), 'names the reset date');
    assert.ok(msg.includes('13 days'), 'says how early it lands');
  });

  it('says the limit is already reached rather than forecasting it', () => {
    const p: UsageProjection = {
      kind: 'projected',
      step: STEP.HALF,
      exhaustionMs: at(0.5).getTime(),
      periodStartMs: P_START,
      periodEndMs: P_END,
      remainingFractionAtExhaustion: 0.5,
      alreadyExhausted: true,
    };
    assert.ok(buildOverageMessage(p, LIMIT).startsWith('Cursor spend has reached'));
  });

  it('has nothing to say while on pace', () => {
    assert.strictEqual(buildOverageMessage(projected(STEP.ON_PACE), LIMIT), '');
  });
});

describe('projectionLines', () => {
  it('confirms the allowance lasts the period when on pace', () => {
    const lines = projectionLines(projected(STEP.ON_PACE), LIMIT);
    assert.strictEqual(lines.length, 1);
    assert.ok(lines[0].includes('on track to last through'));
  });

  it('names the projected date when off pace', () => {
    const lines = projectionLines(projected(STEP.QUARTER), LIMIT);
    assert.ok(lines[0].includes('projected to reach'));
  });

  it('does not forecast a limit that has already been reached', () => {
    const spent = projectUsage({
      spent: LIMIT + 1240,
      limit: LIMIT,
      periodStart: P_START,
      now: at(0.6),
    });
    const lines = projectionLines(spent, LIMIT);
    assert.ok(!lines[0].includes('projected to reach'), 'must not forecast a past event');
    assert.ok(lines[0].includes('reached'));
  });

  it('says so when it is too early to project', () => {
    const lines = projectionLines({ kind: 'too-early', reason: 'elapsed' }, LIMIT);
    assert.ok(lines[0].includes('too early'));
  });

  it('stays quiet when there is no limit to project against', () => {
    assert.deepStrictEqual(projectionLines({ kind: 'no-included' }, undefined), []);
  });
});

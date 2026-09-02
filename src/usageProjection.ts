/**
 * Projects whether current spend will exhaust the monthly allowance before the cycle
 * resets, and decides when that is worth interrupting the user about.
 *
 * No `vscode` import: the pace maths and the notification state machine are both pure
 * so they can be tested outside the editor host.
 */
import type { NormalizedUsage } from './usageModel';
import { formatCentsUsd } from './usageFormat';

/**
 * How early exhaustion lands, as a share of the billing period that would still remain.
 * Step 0 means spend is on pace to last the whole period.
 */
export const STEP = {
  ON_PACE: 0,
  /** Exhaustion lands before the reset, but with under a quarter of the period left. */
  EARLY: 1,
  /** A quarter or more of the period would still remain. */
  QUARTER: 2,
  /** Half or more of the period would still remain. */
  HALF: 3,
} as const;

export type PaceStep = (typeof STEP)[keyof typeof STEP];

/**
 * Floors that suppress projections built on too little evidence. A rate extrapolated from
 * the first hours of a cycle, or from a couple of cents, predicts nothing.
 *
 * These values are a judgement call, not a recovered constant.
 */
export const MIN = {
  /** Share of the period that must have elapsed. Roughly 4.5 days of a 30-day cycle. */
  ELAPSED_FRACTION: 0.15,
  /** Share of the limit that must have been spent. */
  SPEND_FRACTION: 0.05,
} as const;

/** Sentinel high-water mark meaning the user dismissed this period. */
export const DISMISSED = 99;

export type TooEarlyReason = 'elapsed' | 'spend' | 'no-usage';

export type UsageProjection =
  /** No limit to project against. */
  | { kind: 'no-included' }
  /** The billing period is absent, closed, or otherwise unusable. */
  | { kind: 'no-period' }
  /** Not enough of the period, or of the spend, to extrapolate from. */
  | { kind: 'too-early'; reason: TooEarlyReason }
  | {
      kind: 'projected';
      step: PaceStep;
      /** When the allowance is projected to run out. Clamped to now if already exhausted. */
      exhaustionMs: number;
      periodStartMs: number;
      periodEndMs: number;
      /** Share of the period still remaining at exhaustion. Zero when on pace. */
      remainingFractionAtExhaustion: number;
      /** True when the allowance is already spent, so exhaustion is not a forecast. */
      alreadyExhausted: boolean;
    };

/** Accepts ISO timestamps, epoch milliseconds, and epoch milliseconds as a string. */
export function toEpochMs(v: string | number | undefined | null): number | undefined {
  if (typeof v === 'number') {
    return Number.isFinite(v) ? v : undefined;
  }
  if (typeof v !== 'string' || v.trim() === '') {
    return undefined;
  }
  const trimmed = v.trim();
  if (/^-?\d+$/.test(trimmed)) {
    const n = Number(trimmed);
    return Number.isFinite(n) ? n : undefined;
  }
  const parsed = Date.parse(trimmed);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Add whole months, clamping the day to the length of the target month so Jan 31 plus one
 * month lands on Feb 28 (or Feb 29) rather than rolling into March.
 */
export function addMonthsClamped(ms: number, months: number): number {
  const d = new Date(ms);
  const targetMonth = d.getUTCMonth() + months;
  const lastDayOfTarget = new Date(Date.UTC(d.getUTCFullYear(), targetMonth + 1, 0)).getUTCDate();
  return Date.UTC(
    d.getUTCFullYear(),
    targetMonth,
    Math.min(d.getUTCDate(), lastDayOfTarget),
    d.getUTCHours(),
    d.getUTCMinutes(),
    d.getUTCSeconds(),
    d.getUTCMilliseconds()
  );
}

/**
 * Resolve the billing window. Cursor cycles are not reliably calendar-aligned: the
 * 2026-08-24 pricing change produced a short Aug 24 to Sep 1 cycle. So an end reported by
 * the API always wins over the one-month fallback, and a nonsensical end is discarded.
 */
export function resolvePeriodEnd(
  periodStart: string | number | undefined,
  apiEnd: string | number | undefined,
  now: Date
): { startMs: number; endMs: number } {
  const startMs = toEpochMs(periodStart) ?? Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
  const apiEndMs = toEpochMs(apiEnd);
  if (apiEndMs !== undefined && apiEndMs > startMs) {
    return { startMs, endMs: apiEndMs };
  }
  return { startMs, endMs: addMonthsClamped(startMs, 1) };
}

function stepFor(remainingFraction: number): PaceStep {
  if (remainingFraction <= 0) {
    return STEP.ON_PACE;
  }
  if (remainingFraction < 0.25) {
    return STEP.EARLY;
  }
  if (remainingFraction < 0.5) {
    return STEP.QUARTER;
  }
  return STEP.HALF;
}

/**
 * Extrapolate the current spend rate to the point the allowance runs out.
 *
 * The maths is unit-agnostic: it needs only `spent`, `limit` and elapsed time, so it
 * applies unchanged to any allowance Cursor reports, whatever it is denominated in.
 */
export function projectUsage(args: {
  spent?: number;
  limit?: number;
  periodStart?: string | number;
  periodEnd?: string | number;
  now: Date;
}): UsageProjection {
  const { spent, limit, periodStart, periodEnd, now } = args;

  if (spent === undefined || limit === undefined || !(limit > 0)) {
    return { kind: 'no-included' };
  }

  const { startMs, endMs } = resolvePeriodEnd(periodStart, periodEnd, now);
  const nowMs = now.getTime();
  const totalMs = endMs - startMs;
  if (!(totalMs > 0) || nowMs >= endMs || nowMs < startMs) {
    return { kind: 'no-period' };
  }

  const elapsedMs = nowMs - startMs;
  if (elapsedMs / totalMs < MIN.ELAPSED_FRACTION) {
    return { kind: 'too-early', reason: 'elapsed' };
  }
  if (spent <= 0) {
    return { kind: 'too-early', reason: 'no-usage' };
  }
  if (spent / limit < MIN.SPEND_FRACTION) {
    return { kind: 'too-early', reason: 'spend' };
  }

  // Already over the cap: exhaustion is in the past, so report it as of now.
  const alreadyExhausted = spent >= limit;
  const exhaustionMs = alreadyExhausted ? nowMs : nowMs + (limit - spent) / (spent / elapsedMs);

  const remainingFractionAtExhaustion = Math.max(0, (endMs - exhaustionMs) / totalMs);
  return {
    kind: 'projected',
    step: stepFor(remainingFractionAtExhaustion),
    exhaustionMs,
    periodStartMs: startMs,
    periodEndMs: endMs,
    remainingFractionAtExhaustion,
    alreadyExhausted,
  };
}

/** Convenience wrapper for a normalized snapshot. */
export function projectFromUsage(usage: NormalizedUsage, now: Date): UsageProjection {
  return projectUsage({
    spent: usage.spentCents,
    limit: usage.limitCents,
    periodStart: usage.periodStart,
    now,
  });
}

/** Stable identity for a billing period, so notification state resets when it rolls over. */
export function periodIdOf(periodStartMs: number): string {
  return new Date(periodStartMs).toISOString();
}

export type NotifyState = {
  periodId?: string;
  /** Highest step already notified for this period, or DISMISSED. */
  notifiedStep: number;
};

export const INITIAL_NOTIFY_STATE: NotifyState = { notifiedStep: STEP.ON_PACE };

/**
 * Decide whether this poll should raise a notification, and return the state to persist.
 *
 * Only escalation is worth interrupting for: the first off-pace poll fires, an unchanged
 * or improving projection stays silent, and the high-water mark is never lowered within a
 * period. Otherwise a projection oscillating around a threshold would nag on every poll.
 */
export function nextNotification(
  projection: UsageProjection,
  state: NotifyState
): { fire: boolean; state: NotifyState } {
  if (projection.kind !== 'projected') {
    return { fire: false, state };
  }

  const periodId = periodIdOf(projection.periodStartMs);
  const current: NotifyState =
    state.periodId === periodId ? state : { periodId, notifiedStep: STEP.ON_PACE };

  if (current.notifiedStep === DISMISSED) {
    return { fire: false, state: current };
  }
  if (projection.step === STEP.ON_PACE || projection.step <= current.notifiedStep) {
    return { fire: false, state: current };
  }
  return { fire: true, state: { periodId, notifiedStep: projection.step } };
}

/** Mark the current period dismissed. The next period re-arms on its own. */
export function dismissFor(projection: UsageProjection, state: NotifyState): NotifyState {
  if (projection.kind !== 'projected') {
    return state;
  }
  return { periodId: periodIdOf(projection.periodStartMs), notifiedStep: DISMISSED };
}

/** Renders as "Sep 18". */
export function formatShortDate(ms: number): string {
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(ms));
}

function daysBetween(fromMs: number, toMs: number): number {
  return Math.max(0, Math.round((toMs - fromMs) / 86_400_000));
}

/**
 * Notification text. Names the date the allowance runs out and how far short of the reset
 * that lands: the gap is the part that tells you whether to change anything.
 */
export function buildOverageMessage(projection: UsageProjection, limitCents: number): string {
  if (projection.kind !== 'projected' || projection.step === STEP.ON_PACE) {
    return '';
  }
  const early = daysBetween(projection.exhaustionMs, projection.periodEndMs);
  const limit = formatCentsUsd(limitCents);
  const resets = formatShortDate(projection.periodEndMs);
  if (projection.alreadyExhausted) {
    return `Cursor spend has reached your ${limit} limit, ${early} days before it resets on ${resets}.`;
  }
  const exhausts = formatShortDate(projection.exhaustionMs);
  return `Cursor spend is on track to reach your ${limit} limit on ${exhausts}, ${early} days before it resets on ${resets}.`;
}

/** Tooltip lines describing the projection. Empty when there is nothing useful to say. */
export function projectionLines(projection: UsageProjection, limitCents?: number): string[] {
  switch (projection.kind) {
    case 'projected': {
      const resets = formatShortDate(projection.periodEndMs);
      if (projection.step === STEP.ON_PACE) {
        return [`**Pace:** on track to last through ${resets}.`];
      }
      const early = daysBetween(projection.exhaustionMs, projection.periodEndMs);
      const exhausts = formatShortDate(projection.exhaustionMs);
      const limit = limitCents === undefined ? 'your limit' : formatCentsUsd(limitCents);
      return [
        `**Pace:** projected to reach ${limit} on ${exhausts}, ${early} days before the ${resets} reset.`,
      ];
    }
    case 'too-early':
      return ['**Pace:** too early in the cycle to project.'];
    default:
      return [];
  }
}

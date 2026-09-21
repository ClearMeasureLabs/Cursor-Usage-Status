/**
 * Pure presentation helpers. Deliberately free of any `vscode` import so the
 * status bar text and severity rules can be unit tested outside the editor host.
 */
import type { ModelSpend, NormalizedUsage } from './usageModel';
import { overageCents, remainingCents } from './usageModel';

export type StatusSeverity = 'none' | 'warning' | 'critical';

const BOLT = '\u26A1';

export function formatCentsUsd(cents: number): string {
  return new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD' }).format(cents / 100);
}

/** 1_023_923 -> "1.0M", 297_601 -> "298K". Keeps the tooltip readable at a glance. */
export function formatTokens(n: number): string {
  if (n >= 1_000_000) {
    return `${(n / 1_000_000).toFixed(1)}M`;
  }
  if (n >= 1_000) {
    return `${Math.round(n / 1_000)}K`;
  }
  return String(n);
}

/** Models that ran entirely on free credits report token counts but no `totalCents`. */
export function formatModelLine(m: ModelSpend): string {
  const cost = m.cents === undefined ? 'free' : formatCentsUsd(m.cents);
  return `${m.model} — ${cost} (${formatTokens(m.inputTokens)} in / ${formatTokens(m.outputTokens)} out)`;
}

/**
 * Over-limit is rendered explicitly. Clamping to "$0 left" would look identical at
 * $75.01 and $200, and Cursor's behaviour past the cap is not something we can observe.
 */
export function formatPrimaryText(usage: NormalizedUsage, displayFormat: string): string {
  if (usage.spentCents === undefined) {
    return 'Cursor Usage: unavailable';
  }
  const spent = usage.spentCents;

  if (usage.limitCents === undefined) {
    return `${BOLT} ${formatCentsUsd(spent)} used`;
  }

  const over = overageCents(usage);
  if (over > 0) {
    return `${BOLT} ${formatCentsUsd(over)} over`;
  }

  const remaining = remainingCents(usage) ?? 0;
  switch (displayFormat) {
    case 'fraction':
      return `${BOLT} ${formatCentsUsd(spent)}/${formatCentsUsd(usage.limitCents)}`;
    case 'compact':
      return `${BOLT} ${formatCentsUsd(remaining)}`;
    case 'remaining':
    default:
      return `${BOLT} ${formatCentsUsd(remaining)} left`;
  }
}

export function severityFor(
  usage: NormalizedUsage,
  warningRemainingPct: number,
  criticalRemainingPct: number
): StatusSeverity {
  if (usage.spentCents === undefined || usage.limitCents === undefined || usage.limitCents <= 0) {
    return 'none';
  }
  if (overageCents(usage) > 0) {
    return 'critical';
  }
  const remaining = remainingCents(usage) ?? 0;
  const pctOfLimit = (remaining / usage.limitCents) * 100;
  if (pctOfLimit <= criticalRemainingPct) {
    return 'critical';
  }
  if (pctOfLimit <= warningRemainingPct) {
    return 'warning';
  }
  return 'none';
}

import * as vscode from 'vscode';
import type { IncludedBucket, NormalizedUsage } from './usageModel';

export type StatusSeverity = 'none' | 'warning' | 'critical';

function formatCentsUsd(cents: number): string {
  return new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD' }).format(cents / 100);
}

function formatIncludedPrimary(inc: IncludedBucket, displayFormat: string): string {
  const isCents = inc.valueKind === 'cents';
  const remaining = Math.max(0, inc.limit - inc.used);
  if (!isCents) {
    switch (displayFormat) {
      case 'fraction':
        return `\u26A1 ${inc.used}/${inc.limit}`;
      case 'compact':
        return `\u26A1 ${remaining}`;
      case 'remaining':
      default:
        return `\u26A1 ${remaining} left`;
    }
  }
  switch (displayFormat) {
    case 'fraction':
      return `\u26A1 ${formatCentsUsd(inc.used)}/${formatCentsUsd(inc.limit)}`;
    case 'compact':
      return `\u26A1 ${formatCentsUsd(remaining)}`;
    case 'remaining':
    default:
      return `\u26A1 ${formatCentsUsd(remaining)} left`;
  }
}

function severityForIncluded(
  usage: NormalizedUsage,
  warningRemainingPct: number,
  criticalRemainingPct: number
): StatusSeverity {
  const inc = usage.included;
  if (!inc || inc.limit <= 0) {
    return 'none';
  }
  const remaining = Math.max(0, inc.limit - inc.used);
  const pctOfLimit = (remaining / inc.limit) * 100;
  if (pctOfLimit <= criticalRemainingPct) {
    return 'critical';
  }
  if (pctOfLimit <= warningRemainingPct) {
    return 'warning';
  }
  return 'none';
}

function formatPrimaryText(usage: NormalizedUsage, displayFormat: string): string {
  const inc = usage.included;
  if (!inc) {
    return 'Cursor Usage: unavailable';
  }
  return formatIncludedPrimary(inc, displayFormat);
}

function buildTooltipMarkdown(
  usage: NormalizedUsage,
  lastUpdated: Date,
  lastError?: string
): vscode.MarkdownString {
  const md = new vscode.MarkdownString(undefined, true);
  md.appendMarkdown('### Cursor Usage\n\n');
  if (lastError) {
    md.appendMarkdown(`**Status:** ${lastError}\n\n`);
  }
  if (usage.periodStart) {
    md.appendMarkdown(`**Period start:** ${usage.periodStart}\n\n`);
  }
  if (usage.included) {
    const inc = usage.included;
    const remaining = Math.max(0, inc.limit - inc.used);
    if (inc.valueKind === 'cents') {
      md.appendMarkdown(
        `**Included plan spend (${inc.modelKey}):** ${formatCentsUsd(inc.used)} / ${formatCentsUsd(inc.limit)}\n\n`
      );
      md.appendMarkdown(`**Remaining:** ${formatCentsUsd(remaining)}\n\n`);
    } else {
      md.appendMarkdown(`**Included (${inc.modelKey}):** ${inc.used} / ${inc.limit}\n\n`);
      md.appendMarkdown(`**Remaining:** ${remaining}\n\n`);
    }
  } else {
    md.appendMarkdown('_Included request quota not detected from the API response._\n\n');
  }
  if (usage.onDemand?.spentDisplay || usage.onDemand?.limitDisplay) {
    md.appendMarkdown(
      `**On-demand:** ${usage.onDemand.spentDisplay ?? '—'} / ${usage.onDemand.limitDisplay ?? '—'}\n\n`
    );
  }
  if (usage.onDemand?.extraLines?.length) {
    for (const line of usage.onDemand.extraLines) {
      md.appendMarkdown(`${line}\n\n`);
    }
  }
  if (usage.tokenHints?.length) {
    md.appendMarkdown('**Token-related fields (if reported):**\n\n');
    for (const t of usage.tokenHints) {
      md.appendMarkdown(`- \`${t}\`\n`);
    }
    md.appendMarkdown('\n');
  }
  md.appendMarkdown(`_Last updated: ${lastUpdated.toLocaleString()}_\n\n`);
  md.appendMarkdown('_Click to refresh. Undocumented API; may break on Cursor updates._');
  md.isTrusted = false;
  return md;
}

export class UsageStatusBar {
  private readonly item: vscode.StatusBarItem;

  constructor() {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.item.command = 'cursorUsageStatusbar.refresh';
    this.item.name = 'Cursor Usage';
  }

  show(): void {
    this.item.show();
  }

  dispose(): void {
    this.item.dispose();
  }

  update(
    usage: NormalizedUsage,
    displayFormat: string,
    warningRemainingPct: number,
    criticalRemainingPct: number,
    lastUpdated: Date,
    lastError?: string
  ): void {
    this.item.text = formatPrimaryText(usage, displayFormat);
    this.item.tooltip = buildTooltipMarkdown(usage, lastUpdated, lastError);
    const sev = severityForIncluded(usage, warningRemainingPct, criticalRemainingPct);
    if (sev === 'critical') {
      this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
    } else if (sev === 'warning') {
      this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    } else {
      this.item.backgroundColor = undefined;
    }
  }
}

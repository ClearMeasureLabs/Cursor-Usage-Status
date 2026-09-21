import * as vscode from 'vscode';
import type { NormalizedUsage } from './usageModel';
import { overageCents, remainingCents } from './usageModel';
import { formatCentsUsd, formatModelLine, formatPrimaryText, formatTokens, severityFor } from './usageFormat';
import { projectionLines, type UsageProjection } from './usageProjection';

export type { StatusSeverity } from './usageFormat';

function buildTooltipMarkdown(
  usage: NormalizedUsage,
  projection: UsageProjection | undefined,
  lastUpdated: Date,
  lastError?: string
): vscode.MarkdownString {
  const md = new vscode.MarkdownString(undefined, true);
  md.appendMarkdown('### Cursor Usage\n\n');
  if (lastError) {
    md.appendMarkdown(`**Status:** ${lastError}\n\n`);
  }
  if (usage.periodStart) {
    md.appendMarkdown(`**Cycle start:** ${usage.periodStart}\n\n`);
  }

  if (usage.spentCents === undefined) {
    md.appendMarkdown('_Spend not available from the API._\n\n');
  } else if (usage.limitCents === undefined) {
    md.appendMarkdown(`**Spend this cycle:** ${formatCentsUsd(usage.spentCents)}\n\n`);
    md.appendMarkdown('_No per-user limit reported for this account._\n\n');
  } else {
    md.appendMarkdown(
      `**Spend this cycle:** ${formatCentsUsd(usage.spentCents)} / ${formatCentsUsd(usage.limitCents)}\n\n`
    );
    const over = overageCents(usage);
    if (over > 0) {
      md.appendMarkdown(`**Over limit by:** ${formatCentsUsd(over)}\n\n`);
    } else {
      md.appendMarkdown(`**Remaining:** ${formatCentsUsd(remainingCents(usage) ?? 0)}\n\n`);
    }
    if (usage.limitSource === 'manual') {
      md.appendMarkdown('_Limit from `manualMonthlyLimitDollars`, not from Cursor._\n\n');
    }
  }

  if (projection) {
    for (const line of projectionLines(projection, usage.limitCents)) {
      md.appendMarkdown(`${line}\n\n`);
    }
  }

  if (usage.models?.length) {
    md.appendMarkdown('**By model:**\n\n');
    for (const m of usage.models) {
      md.appendMarkdown(`- ${formatModelLine(m)}\n`);
    }
    md.appendMarkdown('\n');
  }

  if (usage.totals) {
    md.appendMarkdown(
      `**Tokens:** ${formatTokens(usage.totals.inputTokens)} in / ` +
        `${formatTokens(usage.totals.outputTokens)} out / ` +
        `${formatTokens(usage.totals.cacheReadTokens)} cache read\n\n`
    );
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

  update(args: {
    usage: NormalizedUsage;
    projection?: UsageProjection;
    displayFormat: string;
    warningRemainingPct: number;
    criticalRemainingPct: number;
    lastUpdated: Date;
    lastError?: string;
  }): void {
    const { usage, projection, displayFormat, warningRemainingPct, criticalRemainingPct } = args;
    this.item.text = formatPrimaryText(usage, displayFormat);
    this.item.tooltip = buildTooltipMarkdown(usage, projection, args.lastUpdated, args.lastError);
    const sev = severityFor(usage, warningRemainingPct, criticalRemainingPct);
    if (sev === 'critical') {
      this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
    } else if (sev === 'warning') {
      this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    } else {
      this.item.backgroundColor = undefined;
    }
  }
}

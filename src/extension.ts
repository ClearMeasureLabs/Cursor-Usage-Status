import * as vscode from 'vscode';
import { readCursorAccessToken, readCursorTeamId } from './cursorAuth';
import { fetchCursorUsage } from './usageClient';
import {
  buildUsage,
  overageCents,
  parseAggregatedUsageEvents,
  parseAuthUsage,
  parseHardLimit,
  remainingCents,
  type NormalizedUsage,
} from './usageModel';
import { parseAllowedApiBase } from './urlAllowlist';
import { formatCentsUsd, formatTokens } from './usageFormat';
import { UsageStatusBar } from './statusBar';

let pollTimer: NodeJS.Timeout | undefined;
let statusBar: UsageStatusBar | undefined;

type UsageSnapshot = {
  usage: NormalizedUsage;
  lastError?: string;
  lastUpdated: Date;
  apiBaseUrl: string;
};

let lastSnapshot: UsageSnapshot | undefined;

function clampPollSeconds(raw: number): number {
  if (!Number.isFinite(raw)) {
    return 300;
  }
  return Math.max(60, Math.floor(raw));
}

function readConfig() {
  const cfg = vscode.workspace.getConfiguration('cursorUsageStatusbar');
  const manual = Number(cfg.get<number>('manualMonthlyLimitDollars') ?? 0);
  return {
    apiBaseUrl: String(cfg.get<string>('apiBaseUrl') ?? 'https://api2.cursor.sh'),
    pollIntervalSeconds: clampPollSeconds(Number(cfg.get<number>('pollIntervalSeconds') ?? 300)),
    displayFormat: String(cfg.get<string>('displayFormat') ?? 'remaining'),
    manualMonthlyLimitDollars: Number.isFinite(manual) && manual > 0 ? manual : undefined,
    warningRemainingPct: Number(cfg.get<number>('warningRemainingPercent') ?? 20),
    criticalRemainingPct: Number(cfg.get<number>('criticalRemainingPercent') ?? 10),
  };
}

function formatDetail(snapshot: UsageSnapshot): string {
  const { usage } = snapshot;
  const lines: string[] = [];
  lines.push(`API base: ${snapshot.apiBaseUrl}`);
  lines.push(`Last updated: ${snapshot.lastUpdated.toLocaleString()}`);
  if (snapshot.lastError) {
    lines.push(`Error: ${snapshot.lastError}`);
  }
  if (usage.periodStart) {
    lines.push(`Cycle start: ${usage.periodStart}`);
  }

  if (usage.spentCents === undefined) {
    lines.push('Spend: not available from API.');
  } else if (usage.limitCents === undefined) {
    lines.push(`Spend this cycle: ${formatCentsUsd(usage.spentCents)} (no per-user limit reported)`);
  } else {
    const over = overageCents(usage);
    lines.push(
      `Spend this cycle: ${formatCentsUsd(usage.spentCents)} / ${formatCentsUsd(usage.limitCents)}` +
        (over > 0
          ? ` (over by ${formatCentsUsd(over)})`
          : ` (remaining ${formatCentsUsd(remainingCents(usage) ?? 0)})`)
    );
    if (usage.limitSource === 'manual') {
      lines.push('Limit source: manualMonthlyLimitDollars setting.');
    }
  }

  if (usage.models?.length) {
    lines.push('By model:');
    for (const m of usage.models) {
      const cost = m.cents === undefined ? 'free' : formatCentsUsd(m.cents);
      lines.push(
        `  - ${m.model}: ${cost} (${formatTokens(m.inputTokens)} in / ${formatTokens(m.outputTokens)} out / ` +
          `${formatTokens(m.cacheReadTokens)} cache read)`
      );
    }
  }

  lines.push('');
  lines.push('Undocumented API; may break on Cursor updates.');
  return lines.join('\n');
}

function publish(snapshot: UsageSnapshot, displayFormat: string, warnPct: number, critPct: number): void {
  lastSnapshot = snapshot;
  statusBar?.update(
    snapshot.usage,
    displayFormat,
    warnPct,
    critPct,
    snapshot.lastUpdated,
    snapshot.lastError
  );
}

async function refreshUsage(): Promise<void> {
  if (!statusBar) {
    return;
  }
  const c = readConfig();
  const lastUpdated = new Date();
  const fail = (lastError: string) =>
    publish(
      { usage: {}, lastError, lastUpdated, apiBaseUrl: c.apiBaseUrl },
      c.displayFormat,
      c.warningRemainingPct,
      c.criticalRemainingPct
    );

  const baseCheck = parseAllowedApiBase(c.apiBaseUrl);
  if (!baseCheck.ok) {
    fail(baseCheck.reason);
    return;
  }

  let token: string | null;
  let teamId: number | null = null;
  try {
    token = await readCursorAccessToken();
    teamId = await readCursorTeamId();
  } catch {
    fail('Could not read Cursor local database.');
    return;
  }
  if (!token) {
    fail('Not signed in to Cursor (no access token found).');
    return;
  }

  let usage: NormalizedUsage = {};
  let lastError: string | undefined;
  try {
    const { auth, hardLimit, aggregated } = await fetchCursorUsage(c.apiBaseUrl, token, teamId, lastUpdated);
    usage = buildUsage({
      auth: auth.ok ? parseAuthUsage(auth.json) : {},
      hardLimit: hardLimit.ok ? parseHardLimit(hardLimit.json) : {},
      aggregated: aggregated.ok ? parseAggregatedUsageEvents(aggregated.json) : {},
      manualLimitDollars: c.manualMonthlyLimitDollars,
    });
    if (usage.spentCents === undefined && !aggregated.ok) {
      lastError = aggregated.error + (aggregated.status !== undefined ? ` (${aggregated.status})` : '');
    }
  } catch (e) {
    lastError = e instanceof Error ? e.message : 'Unknown error.';
  }

  publish(
    { usage, lastError, lastUpdated, apiBaseUrl: c.apiBaseUrl },
    c.displayFormat,
    c.warningRemainingPct,
    c.criticalRemainingPct
  );
}

function schedulePolling(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = undefined;
  }
  const c = readConfig();
  pollTimer = setInterval(() => {
    void refreshUsage();
  }, c.pollIntervalSeconds * 1000);
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  statusBar = new UsageStatusBar();
  statusBar.show();

  context.subscriptions.push(
    new vscode.Disposable(() => {
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = undefined;
      }
      statusBar?.dispose();
      statusBar = undefined;
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('cursorUsageStatusbar.refresh', async () => {
      await refreshUsage();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('cursorUsageStatusbar.showDetails', async () => {
      await refreshUsage();
      const snap = lastSnapshot;
      const detail = snap ? formatDetail(snap) : 'No data yet.';
      await vscode.window.showInformationMessage('Cursor usage', {
        modal: false,
        detail,
      } as vscode.MessageOptions);
    })
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('cursorUsageStatusbar')) {
        schedulePolling();
        void refreshUsage();
      }
    })
  );

  schedulePolling();
  await refreshUsage();
}

export function deactivate(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = undefined;
  }
  statusBar?.dispose();
  statusBar = undefined;
}

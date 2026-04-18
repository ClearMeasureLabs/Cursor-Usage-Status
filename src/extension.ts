import * as vscode from 'vscode';
import { readCursorAccessToken } from './cursorAuth';
import { fetchCursorUsage } from './usageClient';
import {
  mergeDashboardPriority,
  mergeUsage,
  parseAuthUsage,
  parseDashboardPeriodUsage,
  parseUsageSummary,
  type NormalizedUsage,
} from './usageModel';
import { parseAllowedApiBase } from './urlAllowlist';
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
  return {
    apiBaseUrl: String(cfg.get<string>('apiBaseUrl') ?? 'https://api2.cursor.sh'),
    pollIntervalSeconds: clampPollSeconds(Number(cfg.get<number>('pollIntervalSeconds') ?? 300)),
    displayFormat: String(cfg.get<string>('displayFormat') ?? 'remaining'),
    includedModelKey: String(cfg.get<string>('includedModelKey') ?? 'gpt-4'),
    warningRemainingPct: Number(cfg.get<number>('warningRemainingPercent') ?? 20),
    criticalRemainingPct: Number(cfg.get<number>('criticalRemainingPercent') ?? 10),
  };
}

function formatDetail(snapshot: UsageSnapshot): string {
  const lines: string[] = [];
  lines.push(`API base: ${snapshot.apiBaseUrl}`);
  lines.push(`Last updated: ${snapshot.lastUpdated.toLocaleString()}`);
  if (snapshot.lastError) {
    lines.push(`Error: ${snapshot.lastError}`);
  }
  if (snapshot.usage.periodStart) {
    lines.push(`Period start: ${snapshot.usage.periodStart}`);
  }
  if (snapshot.usage.included) {
    const inc = snapshot.usage.included;
    const remaining = Math.max(0, inc.limit - inc.used);
    if (inc.valueKind === 'cents') {
      lines.push(
        `Included plan spend (${inc.modelKey}, USD cents): ${inc.used} / ${inc.limit} (remaining ${remaining})`
      );
    } else {
      lines.push(`Included (${inc.modelKey}): ${inc.used} / ${inc.limit} (remaining ${remaining})`);
    }
  } else {
    lines.push('Included quota: not available from API.');
  }
  if (snapshot.usage.onDemand?.spentDisplay || snapshot.usage.onDemand?.limitDisplay) {
    lines.push(
      `On-demand: ${snapshot.usage.onDemand.spentDisplay ?? '—'} / ${snapshot.usage.onDemand.limitDisplay ?? '—'}`
    );
  }
  if (snapshot.usage.tokenHints?.length) {
    lines.push('Token-related fields:', ...snapshot.usage.tokenHints.map((t) => `  - ${t}`));
  }
  lines.push('');
  lines.push('Undocumented API; may break on Cursor updates.');
  return lines.join('\n');
}

async function refreshUsage(context: vscode.ExtensionContext): Promise<void> {
  if (!statusBar) {
    return;
  }
  const c = readConfig();
  const lastUpdated = new Date();
  let lastError: string | undefined;
  let normalized: NormalizedUsage = {};

  const baseCheck = parseAllowedApiBase(c.apiBaseUrl);
  if (!baseCheck.ok) {
    lastError = baseCheck.reason;
    lastSnapshot = { usage: normalized, lastError, lastUpdated, apiBaseUrl: c.apiBaseUrl };
    statusBar.update(normalized, c.displayFormat, c.warningRemainingPct, c.criticalRemainingPct, lastUpdated, lastError);
    return;
  }

  let token: string | null;
  try {
    token = await readCursorAccessToken();
  } catch {
    lastError = 'Could not read Cursor local database.';
    lastSnapshot = { usage: normalized, lastError, lastUpdated, apiBaseUrl: c.apiBaseUrl };
    statusBar.update(normalized, c.displayFormat, c.warningRemainingPct, c.criticalRemainingPct, lastUpdated, lastError);
    return;
  }
  if (!token) {
    lastError = 'Not signed in to Cursor (no access token found).';
    lastSnapshot = { usage: normalized, lastError, lastUpdated, apiBaseUrl: c.apiBaseUrl };
    statusBar.update(normalized, c.displayFormat, c.warningRemainingPct, c.criticalRemainingPct, lastUpdated, lastError);
    return;
  }

  try {
    const { auth, summary, dashboard } = await fetchCursorUsage(c.apiBaseUrl, token);
    if (auth.ok) {
      normalized = parseAuthUsage(auth.json, c.includedModelKey);
    } else {
      lastError = auth.error + (auth.status ? ` (${auth.status})` : '');
    }
    if (summary.ok) {
      const s = parseUsageSummary(summary.json, c.includedModelKey);
      normalized = mergeUsage(normalized, s);
    }
    if (dashboard.ok) {
      normalized = mergeDashboardPriority(normalized, parseDashboardPeriodUsage(dashboard.json));
    }
    if (normalized.included) {
      lastError = undefined;
    } else if (!lastError && !dashboard.ok) {
      lastError =
        dashboard.error + (dashboard.status !== undefined ? ` (${dashboard.status})` : '');
    }
  } catch (e) {
    lastError = e instanceof Error ? e.message : 'Unknown error.';
  }

  lastSnapshot = { usage: normalized, lastError, lastUpdated, apiBaseUrl: c.apiBaseUrl };
  statusBar.update(normalized, c.displayFormat, c.warningRemainingPct, c.criticalRemainingPct, lastUpdated, lastError);
}

function schedulePolling(context: vscode.ExtensionContext): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = undefined;
  }
  const c = readConfig();
  pollTimer = setInterval(() => {
    void refreshUsage(context);
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
      await refreshUsage(context);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('cursorUsageStatusbar.showDetails', async () => {
      await refreshUsage(context);
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
        schedulePolling(context);
        void refreshUsage(context);
      }
    })
  );

  schedulePolling(context);
  await refreshUsage(context);
}

export function deactivate(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = undefined;
  }
  statusBar?.dispose();
  statusBar = undefined;
}

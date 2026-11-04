import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { DatabaseSync } from 'node:sqlite';

const ACCESS_KEY = 'cursorAuth/accessToken';
const TEAM_KEY = 'cursorAuth/cachedTeam';

/** Cursor's Electron userData directory (holds `Local State` and `User/globalStorage`). */
export function resolveCursorUserDataDir(): string {
  const home = os.homedir();
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA;
    if (!appData) {
      throw new Error('APPDATA environment variable is not set.');
    }
    return path.join(appData, 'Cursor');
  }
  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'Cursor');
  }
  return path.join(home, '.config', 'Cursor');
}

export function resolveCursorStateDbPath(): string {
  return path.join(resolveCursorUserDataDir(), 'User', 'globalStorage', 'state.vscdb');
}

export type CursorLocalState = {
  /** Raw stored value: a plaintext JWT, or `cursor-safe-storage:v1:` ciphertext. */
  accessToken: string | null;
  teamId: number | null;
};

/**
 * Read the auth token and cached team id from Cursor local SQLite in one read-only open.
 *
 * node:sqlite reads only the pages it needs and applies the WAL, so values Cursor wrote
 * moments ago (a refreshed token, say) are visible. This matters because state.vscdb can
 * exceed a gigabyte. Values are never logged or persisted by callers.
 */
export function readCursorLocalState(dbPath: string = resolveCursorStateDbPath()): CursorLocalState {
  if (!fs.existsSync(dbPath)) {
    return { accessToken: null, teamId: null };
  }
  const db = new DatabaseSync(dbPath, { readOnly: true, timeout: 2_000 });
  try {
    const stmt = db.prepare('SELECT value FROM ItemTable WHERE key = ? LIMIT 1');
    const read = (key: string): string | null => {
      const row = stmt.get(key) as { value?: unknown } | undefined;
      return valueToString(row?.value);
    };
    return { accessToken: read(ACCESS_KEY), teamId: parseCachedTeamId(read(TEAM_KEY)) };
  } finally {
    db.close();
  }
}

function valueToString(raw: unknown): string | null {
  if (typeof raw === 'string') {
    return raw.length > 0 ? raw : null;
  }
  if (raw instanceof Uint8Array) {
    return Buffer.from(raw).toString('utf8') || null;
  }
  return null;
}

/**
 * Team id from Cursor's `cursorAuth/cachedTeam` JSON. Required for perUserMonthlyLimitDollars
 * from GetHardLimit - without a team id that response carries only the team-wide total.
 * Returns null for individual accounts, which have no per-user cap to report.
 */
export function parseCachedTeamId(raw: string | null): number | null {
  if (!raw) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      const id = (parsed as { teamId?: unknown }).teamId;
      if (typeof id === 'number' && Number.isFinite(id)) {
        return id;
      }
      if (typeof id === 'string' && id.trim() !== '' && Number.isFinite(Number(id))) {
        return Number(id);
      }
    }
  } catch {
    return null;
  }
  return null;
}

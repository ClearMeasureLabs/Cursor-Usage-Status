import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const ACCESS_KEY = 'cursorAuth/accessToken';

export function resolveCursorStateDbPath(): string {
  const home = os.homedir();
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA;
    if (!appData) {
      throw new Error('APPDATA environment variable is not set.');
    }
    return path.join(appData, 'Cursor', 'User', 'globalStorage', 'state.vscdb');
  }
  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage', 'state.vscdb');
  }
  return path.join(home, '.config', 'Cursor', 'User', 'globalStorage', 'state.vscdb');
}

/**
 * Read Cursor access token from local SQLite. Returns null if missing/unreadable.
 * Token is never logged or persisted by callers.
 */
export async function readCursorAccessToken(): Promise<string | null> {
  const dbPath = resolveCursorStateDbPath();
  if (!fs.existsSync(dbPath)) {
    return null;
  }
  const fileBuffer = fs.readFileSync(dbPath);
  const wasmPath = path.join(__dirname, '..', 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm');
  if (!fs.existsSync(wasmPath)) {
    throw new Error('sql.js WASM file is missing from the extension install.');
  }
  const wasmBinary = fs.readFileSync(wasmPath);
  const sqlJsMod = await import('sql.js');
  type InitSqlJs = (opts?: { wasmBinary?: Buffer | Uint8Array }) => Promise<import('sql.js').SqlJsStatic>;
  const initSqlJs: InitSqlJs =
    typeof (sqlJsMod as { default?: InitSqlJs }).default === 'function'
      ? (sqlJsMod as { default: InitSqlJs }).default
      : (sqlJsMod as unknown as InitSqlJs);
  const SQL = await initSqlJs({ wasmBinary });
  const db = new SQL.Database(new Uint8Array(fileBuffer));
  try {
    const stmt = db.prepare('SELECT value FROM ItemTable WHERE key = ? LIMIT 1');
    stmt.bind([ACCESS_KEY]);
    if (!stmt.step()) {
      return null;
    }
    const row = stmt.getAsObject() as { value?: string | Uint8Array };
    stmt.free();
    const raw = row.value;
    if (typeof raw === 'string' && raw.length > 0) {
      return raw;
    }
    if (raw instanceof Uint8Array) {
      return Buffer.from(raw).toString('utf8') || null;
    }
    return null;
  } finally {
    db.close();
  }
}

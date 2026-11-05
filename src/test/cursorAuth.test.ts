import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DatabaseSync } from 'node:sqlite';
import { parseCachedTeamId, readCursorLocalState } from '../cursorAuth';

describe('cursorAuth', () => {
  describe('parseCachedTeamId', () => {
    it('reads numeric and numeric-string team ids', () => {
      assert.strictEqual(parseCachedTeamId('{"teamId":12345}'), 12345);
      assert.strictEqual(parseCachedTeamId('{"teamId":"12345"}'), 12345);
    });

    it('returns null for missing, malformed or non-numeric values', () => {
      assert.strictEqual(parseCachedTeamId(null), null);
      assert.strictEqual(parseCachedTeamId('not json'), null);
      assert.strictEqual(parseCachedTeamId('{"teamId":"abc"}'), null);
      assert.strictEqual(parseCachedTeamId('[1]'), null);
    });
  });

  describe('readCursorLocalState', () => {
    let dir: string;
    let writer: DatabaseSync;
    let dbPath: string;

    beforeEach(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-usage-state-'));
      dbPath = path.join(dir, 'state.vscdb');
      // Mirror Cursor: WAL mode, with a writer connection still open (uncheckpointed WAL).
      writer = new DatabaseSync(dbPath);
      writer.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;');
      writer.exec('CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)');
    });

    afterEach(() => {
      writer.close();
      fs.rmSync(dir, { recursive: true, force: true });
    });

    it('sees values that exist only in the WAL', () => {
      const put = writer.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)');
      put.run('cursorAuth/accessToken', 'cursor-safe-storage:v1:djEw');
      put.run('cursorAuth/cachedTeam', '{"teamId":42}');
      assert.ok(fs.statSync(dbPath + '-wal').size > 0, 'expected rows to be in the WAL');

      assert.deepStrictEqual(readCursorLocalState(dbPath), {
        accessToken: 'cursor-safe-storage:v1:djEw',
        teamId: 42,
      });
    });

    it('decodes BLOB-typed values', () => {
      writer.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)').run('cursorAuth/accessToken', Buffer.from('tok'));
      assert.strictEqual(readCursorLocalState(dbPath).accessToken, 'tok');
    });

    it('returns nulls when signed out or the database is missing', () => {
      assert.deepStrictEqual(readCursorLocalState(dbPath), { accessToken: null, teamId: null });
      assert.deepStrictEqual(readCursorLocalState(path.join(dir, 'missing.vscdb')), { accessToken: null, teamId: null });
    });
  });
});

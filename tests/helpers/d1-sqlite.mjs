// Adapter test: subset API binding D1 di atas `node:sqlite` (Node 24, tanpa dependensi).
//
// Perilaku D1 yang ditiru (diverifikasi terhadap D1 lokal wrangler 4.132 / getPlatformProxy):
// - foreign key ON;
// - error dilempar sebagai `Error` dengan pesan
//   `D1_ERROR: <pesan SQLite>: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_<JENIS>)` dan `cause`
//   berisi pesan tanpa prefix `D1_ERROR: `;
// - hasil `{ results, success, meta: { changes, last_row_id, ... } }`;
// - `first()` tanpa baris = `null`; `first(col)` dengan kolom tak dikenal = `D1_COLUMN_NOTFOUND`;
// - bind `undefined` = `D1_TYPE_ERROR`; boolean diikat sebagai 1/0;
// - `batch()` atomik (rollback seluruhnya bila satu statement gagal);
// - `exec()` memecah per baris dan mengembalikan `{ count, duration }`;
// - transaksi eksplisit (`BEGIN`/`COMMIT`/`SAVEPOINT`/...) ditolak.

import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const DEFAULT_MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/', import.meta.url));

const TRANSACTION_CONTROL = /^\s*(BEGIN|COMMIT|END|ROLLBACK|SAVEPOINT|RELEASE)\b/i;

const EXTENDED_CONSTRAINT = new Map([
  [275, 'SQLITE_CONSTRAINT_CHECK'],
  [531, 'SQLITE_CONSTRAINT_COMMITHOOK'],
  [787, 'SQLITE_CONSTRAINT_FOREIGNKEY'],
  [1043, 'SQLITE_CONSTRAINT_FUNCTION'],
  [1299, 'SQLITE_CONSTRAINT_NOTNULL'],
  [1555, 'SQLITE_CONSTRAINT_PRIMARYKEY'],
  [1811, 'SQLITE_CONSTRAINT_TRIGGER'],
  [2067, 'SQLITE_CONSTRAINT_UNIQUE'],
  [2323, 'SQLITE_CONSTRAINT_VTAB'],
  [2579, 'SQLITE_CONSTRAINT_ROWID'],
  [2835, 'SQLITE_CONSTRAINT_PINNED'],
  [3091, 'SQLITE_CONSTRAINT_DATATYPE'],
]);

const PRIMARY_CODE = new Map([
  [1, 'SQLITE_ERROR'],
  [18, 'SQLITE_TOOBIG'],
  [19, 'SQLITE_CONSTRAINT'],
  [20, 'SQLITE_MISMATCH'],
  [25, 'SQLITE_RANGE'],
]);

/**
 * Database in-memory baru dengan seluruh `migrations/*.sql` diterapkan berurutan.
 * @param {{ migrationsDir?: string, migrations?: boolean }} [options]
 */
export function createTestDb(options = {}) {
  const sqlite = new DatabaseSync(':memory:', { enableForeignKeyConstraints: true });
  sqlite.exec('PRAGMA foreign_keys = ON');
  const db = new D1DatabaseAdapter(sqlite);
  if (options.migrations !== false) {
    db.appliedMigrations = applyMigrations(sqlite, options.migrationsDir ?? DEFAULT_MIGRATIONS_DIR);
  }
  return db;
}

/**
 * Menerapkan file migrasi berurutan nama, masing-masing atomik, dan mencatatnya di `d1_migrations`
 * seperti `wrangler d1 migrations apply`.
 * @returns {{ name: string, statements: number }[]}
 */
export function applyMigrations(sqlite, migrationsDir) {
  sqlite.exec(`CREATE TABLE IF NOT EXISTS d1_migrations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE,
    applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
  )`);
  const files = readdirSync(migrationsDir)
    .filter((name) => name.endsWith('.sql'))
    .sort();
  const applied = [];
  for (const name of files) {
    const statements = splitSqlStatements(readFileSync(path.join(migrationsDir, name), 'utf8'));
    for (const sql of statements) {
      if (TRANSACTION_CONTROL.test(stripLeadingComments(sql))) {
        throw new Error(`Migration ${name} contains explicit transaction control, which D1 rejects: ${sql.slice(0, 40)}`);
      }
    }
    sqlite.exec('BEGIN IMMEDIATE');
    try {
      for (const sql of statements) {
        sqlite.prepare(sql).run();
      }
      sqlite.prepare('INSERT INTO d1_migrations (name) VALUES (?)').run(name);
      sqlite.exec('COMMIT');
    } catch (error) {
      sqlite.exec('ROLLBACK');
      throw new Error(`Migration ${name} failed: ${error.message}`, { cause: error });
    }
    applied.push({ name, statements: statements.length });
  }
  return applied;
}

/**
 * Memecah skrip SQL menjadi statement. Memahami string '…', identifier "…", `…`, […],
 * komentar `--` dan `/* *\/`, serta blok `CREATE TRIGGER … BEGIN … END;` (termasuk CASE…END di dalamnya).
 * Statement yang hanya berisi komentar/spasi dibuang.
 * @param {string} script
 * @returns {string[]}
 */
export function splitSqlStatements(script) {
  const statements = [];
  let start = 0;
  let words = [];
  let isTrigger = false;
  let inBody = false;
  let depth = 0;
  let i = 0;
  const n = script.length;

  const flush = (end) => {
    const sql = stripLeadingComments(script.slice(start, end)).trim();
    if (sql !== '') statements.push(sql);
    start = end + 1;
    words = [];
    isTrigger = false;
    inBody = false;
    depth = 0;
  };

  const onWord = (word) => {
    const upper = word.toUpperCase();
    if (words.length < 4) {
      words.push(upper);
      if (words[0] === 'CREATE' && (upper === 'TRIGGER')) isTrigger = true;
    }
    if (!isTrigger) return;
    if (!inBody) {
      if (upper === 'BEGIN') {
        inBody = true;
        depth = 1;
      }
      return;
    }
    if (upper === 'CASE' || upper === 'BEGIN') depth += 1;
    else if (upper === 'END') depth -= 1;
  };

  while (i < n) {
    const ch = script[i];
    const next = script[i + 1];
    if (ch === '-' && next === '-') {
      const eol = script.indexOf('\n', i);
      i = eol === -1 ? n : eol + 1;
    } else if (ch === '/' && next === '*') {
      const close = script.indexOf('*/', i + 2);
      if (close === -1) throw new SyntaxError('Unterminated block comment in SQL script');
      i = close + 2;
    } else if (ch === "'" || ch === '"' || ch === '`') {
      i = skipQuoted(script, i, ch);
    } else if (ch === '[') {
      const close = script.indexOf(']', i + 1);
      if (close === -1) throw new SyntaxError('Unterminated [identifier] in SQL script');
      i = close + 1;
    } else if (/[A-Za-z_]/.test(ch)) {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_$]/.test(script[j])) j += 1;
      onWord(script.slice(i, j));
      i = j;
    } else if (ch === ';') {
      if (!isTrigger || (inBody && depth <= 0)) flush(i);
      i += 1;
    } else {
      i += 1;
    }
  }
  if (isTrigger && depth > 0) throw new SyntaxError('Unterminated CREATE TRIGGER block in SQL script');
  flush(n);
  return statements;
}

function skipQuoted(script, index, quote) {
  let i = index + 1;
  while (i < script.length) {
    if (script[i] === quote) {
      if (script[i + 1] === quote) {
        i += 2;
        continue;
      }
      return i + 1;
    }
    i += 1;
  }
  throw new SyntaxError(`Unterminated ${quote} literal in SQL script`);
}

function stripLeadingComments(sql) {
  let s = sql.trimStart();
  for (;;) {
    if (s.startsWith('--')) {
      const eol = s.indexOf('\n');
      s = eol === -1 ? '' : s.slice(eol + 1).trimStart();
    } else if (s.startsWith('/*')) {
      const close = s.indexOf('*/');
      s = close === -1 ? '' : s.slice(close + 2).trimStart();
    } else {
      return s;
    }
  }
}

export class D1DatabaseAdapter {
  constructor(sqlite) {
    this.sqlite = sqlite;
    this.appliedMigrations = [];
  }

  prepare(sql) {
    if (typeof sql !== 'string') throw new TypeError('D1_TYPE_ERROR: SQL must be a string');
    return new D1PreparedStatementAdapter(this, sql, []);
  }

  async batch(statements) {
    if (!Array.isArray(statements)) throw new TypeError('batch() expects an array of prepared statements');
    for (const stmt of statements) {
      if (!(stmt instanceof D1PreparedStatementAdapter) || stmt.database !== this) {
        throw new TypeError('batch() expects statements prepared on this database');
      }
    }
    if (statements.length === 0) return [];
    this.sqlite.exec('BEGIN IMMEDIATE');
    try {
      const results = statements.map((stmt) => stmt.execute('all'));
      this.sqlite.exec('COMMIT');
      return results;
    } catch (error) {
      if (this.sqlite.isTransaction) this.sqlite.exec('ROLLBACK');
      throw error;
    }
  }

  /** Seperti D1: memecah per baris, tiap baris dieksekusi terpisah. */
  async exec(query) {
    const started = performance.now();
    const lines = String(query)
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '');
    let count = 0;
    for (const line of lines) {
      rejectTransactionControl(line);
      try {
        this.sqlite.exec(line);
      } catch (error) {
        throw toD1Error(error);
      }
      count += 1;
    }
    return { count, duration: performance.now() - started };
  }

  async dump() {
    throw new Error('D1_DUMP_ERROR: dump() is not supported by the test adapter');
  }

  close() {
    if (this.sqlite.isOpen) this.sqlite.close();
  }
}

export class D1PreparedStatementAdapter {
  constructor(database, sql, params) {
    this.database = database;
    this.sql = sql;
    this.params = params;
  }

  bind(...values) {
    return new D1PreparedStatementAdapter(this.database, this.sql, values.map(toSqliteValue));
  }

  async first(columnName) {
    const { results } = this.execute('all');
    const row = results[0];
    if (columnName === undefined) return row ?? null;
    if (!row) return null;
    if (!Object.hasOwn(row, columnName)) {
      throw new Error(`D1_COLUMN_NOTFOUND: Column not found (${columnName})`, { cause: new Error('Column not found') });
    }
    return row[columnName];
  }

  async all() {
    return this.execute('all');
  }

  async run() {
    return this.execute('all');
  }

  async raw(options = {}) {
    return this.execute('raw', options.columnNames === true);
  }

  /** @internal sinkron, dipakai juga oleh batch(). */
  execute(mode, columnNames = false) {
    rejectTransactionControl(this.sql);
    const { sqlite } = this.database;
    const started = performance.now();
    try {
      const before = sqlite.prepare('SELECT total_changes() AS t').get().t;
      const stmt = sqlite.prepare(this.sql);
      let rows;
      let columns = [];
      if (mode === 'raw') {
        columns = stmt.columns().map((column) => column.name);
        stmt.setReturnArrays(true);
        rows = stmt.all(...this.params).map((row) => [...row]);
      } else {
        rows = stmt.all(...this.params).map((row) => ({ ...row }));
      }
      const after = sqlite.prepare('SELECT total_changes() AS t, last_insert_rowid() AS id').get();
      // D1 menghitung baris yang ikut berubah lewat FK cascade/trigger (diverifikasi: DELETE user dengan
      // 1 sesi = changes 2), sehingga dipakai selisih total_changes(), bukan changes().
      const changes = after.t - before;
      if (mode === 'raw') return columnNames ? [columns, ...rows] : rows;
      return {
        results: rows,
        success: true,
        meta: {
          served_by: 'node:sqlite',
          duration: performance.now() - started,
          changes,
          last_row_id: after.id,
          changed_db: changes > 0,
          rows_read: 0,
          rows_written: changes,
        },
      };
    } catch (error) {
      throw toD1Error(error);
    }
  }
}

function toSqliteValue(value) {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint') {
    return value;
  }
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  const type = value === undefined ? 'undefined' : typeof value;
  throw new Error(`D1_TYPE_ERROR: Type '${type}' not supported for value '${String(value)}'`);
}

function rejectTransactionControl(sql) {
  if (TRANSACTION_CONTROL.test(stripLeadingComments(sql))) {
    throw new Error(
      'D1_ERROR: To execute a transaction, please use the state.storage.transaction() or state.storage.transactionSync() APIs instead of the SQL BEGIN TRANSACTION or SAVEPOINT statements.',
    );
  }
}

/** Mengubah error node:sqlite menjadi bentuk pesan D1. */
export function toD1Error(error) {
  if (!error || error.code !== 'ERR_SQLITE_ERROR' || typeof error.errcode !== 'number') return error;
  const primary = PRIMARY_CODE.get(error.errcode & 0xff) ?? 'SQLITE_ERROR';
  const extended = EXTENDED_CONSTRAINT.get(error.errcode);
  const detail = extended ? `${error.message}: ${primary} (extended: ${extended})` : `${error.message}: ${primary}`;
  const d1Error = new Error(`D1_ERROR: ${detail}`, { cause: new Error(detail) });
  d1Error.sqliteErrcode = error.errcode;
  return d1Error;
}

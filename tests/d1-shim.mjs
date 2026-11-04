// Minimal Cloudflare D1 look-alike on top of Node's built-in SQLite (Node 22+).
// Same surface the Worker uses: prepare().bind().first()/all()/run(), and batch() as ONE transaction.
import { DatabaseSync } from 'node:sqlite';

class Statement {
  constructor(db, sql, params = []) { this.db = db; this.sql = sql; this.params = params; }
  bind(...params) { return new Statement(this.db, this.sql, params); }
  _stmt() { return this.db.prepare(this.sql); }
  async first() { const r = this._stmt().get(...this.params); return r === undefined ? null : { ...r }; }
  async all() { return { results: this._stmt().all(...this.params).map((r) => ({ ...r })) }; }
  async run() { const r = this._stmt().run(...this.params); return { success: true, meta: { changes: r.changes } }; }
  _allSync() { return { results: this._stmt().all(...this.params).map((r) => ({ ...r })) }; }
}

export class D1Shim {
  constructor() {
    this.db = new DatabaseSync(':memory:');
    // Match Cloudflare SQLite unixepoch() while keeping campaign boundary tests deterministic.
    this.db.function('unixepoch', () => Math.floor(Date.now() / 1000));
  }
  exec(sql) { this.db.exec(sql); }
  prepare(sql) { return new Statement(this.db, sql); }
  async batch(statements) {
    this.db.exec('BEGIN');
    try {
      const out = statements.map((s) => s._allSync());
      this.db.exec('COMMIT');
      return out;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }
}

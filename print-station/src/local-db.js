const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

// Local catalog database helper for Electron main process
// Schema focuses on decals staged locally prior to publishing to the hosted server

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function getDbPath(app) {
  const base = path.join(app.getPath('userData'), 'local-catalog');
  ensureDir(base);
  return path.join(base, 'catalog.db');
}

function openDb(app) {
  const dbPath = getDbPath(app);
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');

  db.exec(
    `CREATE TABLE IF NOT EXISTS local_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      path TEXT NOT NULL,
      category TEXT,
      title TEXT,
      file_type TEXT,
      size INTEGER,
      hash TEXT,
      phash TEXT,
      optimized_path TEXT,
      tags TEXT,
      status TEXT DEFAULT 'imported',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_local_items_hash ON local_items(hash);
    CREATE INDEX IF NOT EXISTS idx_local_items_status ON local_items(status);
    CREATE INDEX IF NOT EXISTS idx_local_items_phash ON local_items(phash);
  `
  );

  // Simple trigger to bump updated_at
  db.exec(
    `CREATE TRIGGER IF NOT EXISTS trg_local_items_updated
       AFTER UPDATE ON local_items
       BEGIN
         UPDATE local_items SET updated_at = datetime('now') WHERE id = NEW.id;
       END;`
  );

  // Lightweight migration to ensure columns exist for older DBs
  try {
    const cols = db.prepare("PRAGMA table_info('local_items')").all();
    const names = new Set(cols.map((c) => c.name));
    const alters = [];
    if (!names.has('phash')) alters.push("ALTER TABLE local_items ADD COLUMN phash TEXT");
    if (!names.has('tags')) alters.push("ALTER TABLE local_items ADD COLUMN tags TEXT");
    for (const sql of alters) {
      try { db.exec(sql); } catch (_) {}
    }
  } catch (_) {}

  return db;
}

class LocalCatalogDB {
  constructor(app) {
    this.app = app;
    this.db = openDb(app);
  }

  close() {
    try { this.db.close(); } catch (_) {}
  }

  findByHash(hash) {
    if (!hash) return null;
    const stmt = this.db.prepare('SELECT * FROM local_items WHERE hash = ? LIMIT 1');
    return stmt.get(hash) || null;
  }

  allPhashes() {
    const stmt = this.db.prepare('SELECT id, phash FROM local_items WHERE phash IS NOT NULL');
    return stmt.all();
  }

  categories() {
    const stmt = this.db.prepare(
      `SELECT COALESCE(category,'') AS category, COUNT(*) AS count,
              SUM(CASE WHEN status='approved' THEN 1 ELSE 0 END) AS approved,
              SUM(CASE WHEN status='published' THEN 1 ELSE 0 END) AS published
         FROM local_items
        GROUP BY COALESCE(category,'')
        ORDER BY category COLLATE NOCASE`
    );
    return stmt.all();
  }

  getById(id) {
    const stmt = this.db.prepare('SELECT * FROM local_items WHERE id = ?');
    return stmt.get(id) || null;
  }

  list({ status, search, limit = 500, offset = 0 } = {}) {
    const clauses = [];
    const params = {};
    if (status && status !== 'all') {
      clauses.push('status = @status');
      params.status = status;
    }
    if (search) {
      clauses.push('(title LIKE @q OR category LIKE @q OR path LIKE @q)');
      params.q = `%${search}%`;
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const stmt = this.db.prepare(
      `SELECT *
         FROM local_items
        ${where}
        ORDER BY datetime(created_at) DESC
        LIMIT @limit OFFSET @offset`
    );
    return stmt.all({ ...params, limit, offset });
  }

  upsert(item) {
    // Deduplicate by hash if provided, otherwise by path
    let existing = null;
    if (item.hash) existing = this.findByHash(item.hash);
    if (!existing && item.path) {
      const stmt = this.db.prepare('SELECT * FROM local_items WHERE path = ? LIMIT 1');
      existing = stmt.get(item.path) || null;
    }

    if (existing) {
      const next = {
        category: item.category ?? existing.category,
        title: item.title ?? existing.title,
        file_type: item.file_type ?? existing.file_type,
        size: item.size ?? existing.size,
        hash: item.hash ?? existing.hash,
        phash: item.phash ?? existing.phash,
        optimized_path: item.optimized_path ?? existing.optimized_path,
        tags: item.tags ?? existing.tags,
        status: item.status ?? existing.status,
        id: existing.id
      };
      const upd = this.db.prepare(
        `UPDATE local_items
           SET category=@category, title=@title, file_type=@file_type, size=@size,
               hash=@hash, phash=@phash, optimized_path=@optimized_path, tags=@tags, status=@status
         WHERE id=@id`
      );
      upd.run(next);
      return this.getById(existing.id);
    }

    const ins = this.db.prepare(
      `INSERT INTO local_items (path, category, title, file_type, size, hash, phash, optimized_path, tags, status)
       VALUES (@path, @category, @title, @file_type, @size, @hash, @phash, @optimized_path, @tags, @status)`
    );
    const info = ins.run({
      path: item.path,
      category: item.category || null,
      title: item.title || null,
      file_type: item.file_type || null,
      size: item.size || null,
      hash: item.hash || null,
      phash: item.phash || null,
      optimized_path: item.optimized_path || null,
      tags: item.tags || null,
      status: item.status || 'imported'
    });
    return this.getById(info.lastInsertRowid);
  }

  update(id, updates = {}) {
    const allowed = ['path', 'category', 'title', 'file_type', 'size', 'hash', 'phash', 'optimized_path', 'tags', 'status'];
    const set = [];
    const params = { id };
    for (const key of allowed) {
      if (Object.prototype.hasOwnProperty.call(updates, key)) {
        set.push(`${key} = @${key}`);
        params[key] = updates[key];
      }
    }
    if (!set.length) return this.getById(id);
    const stmt = this.db.prepare(`UPDATE local_items SET ${set.join(', ')} WHERE id = @id`);
    stmt.run(params);
    return this.getById(id);
  }

  updateMany(ids = [], updates = {}) {
    if (!Array.isArray(ids) || !ids.length) return 0;
    const allowed = ['path', 'category', 'title', 'file_type', 'size', 'hash', 'phash', 'optimized_path', 'tags', 'status'];
    const set = [];
    const params = {};
    for (const key of allowed) {
      if (Object.prototype.hasOwnProperty.call(updates, key)) {
        set.push(`${key}=@${key}`);
        params[key] = updates[key];
      }
    }
    if (!set.length) return 0;
    const placeholders = ids.map((_, i) => `@id${i}`);
    ids.forEach((id, i) => (params[`id${i}`] = id));
    const stmt = this.db.prepare(`UPDATE local_items SET ${set.join(', ')} WHERE id IN (${placeholders.join(',')})`);
    const info = stmt.run(params);
    return info.changes || 0;
  }

  approveCategory(category) {
    const stmt = this.db.prepare(`UPDATE local_items SET status='approved' WHERE category = ?`);
    const info = stmt.run(category || '');
    return info.changes || 0;
  }

  remove(id) {
    const stmt = this.db.prepare('DELETE FROM local_items WHERE id = ?');
    return stmt.run(id);
  }
}

module.exports = { LocalCatalogDB };

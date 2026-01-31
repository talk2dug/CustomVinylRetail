const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function getDbPath(app) {
  const base = path.join(app.getPath('userData'), 'stl-catalog');
  ensureDir(base);
  return path.join(base, 'stl.db');
}

function openDb(app) {
  const dbPath = getDbPath(app);
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS stl_models (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      file_path TEXT NOT NULL UNIQUE,
      filename TEXT NOT NULL,
      category TEXT DEFAULT '',
      tags TEXT DEFAULT '',
      notes TEXT DEFAULT '',
      favorite INTEGER DEFAULT 0,
      format TEXT DEFAULT 'binary',
      triangle_count INTEGER DEFAULT 0,
      dim_x REAL DEFAULT 0,
      dim_y REAL DEFAULT 0,
      dim_z REAL DEFAULT 0,
      file_size INTEGER DEFAULT 0,
      thumbnail_path TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_stl_filename ON stl_models(filename);
    CREATE INDEX IF NOT EXISTS idx_stl_category ON stl_models(category);
    CREATE INDEX IF NOT EXISTS idx_stl_favorite ON stl_models(favorite);
  `);

  db.exec(`
    CREATE TRIGGER IF NOT EXISTS trg_stl_models_updated
      AFTER UPDATE ON stl_models
      BEGIN
        UPDATE stl_models SET updated_at = datetime('now') WHERE id = NEW.id;
      END;
  `);

  return db;
}

class StlCatalogDB {
  constructor(app) {
    this.app = app;
    this.db = openDb(app);
  }

  close() {
    try { this.db.close(); } catch (_) {}
  }

  getById(id) {
    return this.db.prepare('SELECT * FROM stl_models WHERE id = ?').get(id) || null;
  }

  getByPath(filePath) {
    return this.db.prepare('SELECT * FROM stl_models WHERE file_path = ?').get(filePath) || null;
  }

  list({ search, category, favorite, limit = 50, offset = 0, sortBy = 'filename', sortDir = 'ASC' } = {}) {
    const clauses = [];
    const params = {};

    if (search) {
      clauses.push('(filename LIKE @q OR tags LIKE @q OR category LIKE @q OR notes LIKE @q)');
      params.q = `%${search}%`;
    }
    if (category) {
      clauses.push('category = @category');
      params.category = category;
    }
    if (favorite) {
      clauses.push('favorite = 1');
    }

    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

    const allowedSort = ['filename', 'created_at', 'updated_at', 'dim_x', 'dim_y', 'dim_z', 'triangle_count', 'file_size', 'category'];
    const col = allowedSort.includes(sortBy) ? sortBy : 'filename';
    const dir = sortDir === 'DESC' ? 'DESC' : 'ASC';

    const stmt = this.db.prepare(`
      SELECT * FROM stl_models ${where}
      ORDER BY ${col} ${dir}
      LIMIT @limit OFFSET @offset
    `);
    return stmt.all({ ...params, limit, offset });
  }

  count({ search, category, favorite } = {}) {
    const clauses = [];
    const params = {};

    if (search) {
      clauses.push('(filename LIKE @q OR tags LIKE @q OR category LIKE @q OR notes LIKE @q)');
      params.q = `%${search}%`;
    }
    if (category) {
      clauses.push('category = @category');
      params.category = category;
    }
    if (favorite) {
      clauses.push('favorite = 1');
    }

    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const stmt = this.db.prepare(`SELECT COUNT(*) AS total FROM stl_models ${where}`);
    return stmt.get(params).total;
  }

  upsert(item) {
    const existing = item.file_path ? this.getByPath(item.file_path) : null;

    if (existing) {
      const upd = this.db.prepare(`
        UPDATE stl_models
        SET filename=@filename, category=@category, format=@format,
            triangle_count=@triangle_count, dim_x=@dim_x, dim_y=@dim_y, dim_z=@dim_z,
            file_size=@file_size
        WHERE id=@id
      `);
      upd.run({
        filename: item.filename ?? existing.filename,
        category: item.category ?? existing.category,
        format: item.format ?? existing.format,
        triangle_count: item.triangle_count ?? existing.triangle_count,
        dim_x: item.dim_x ?? existing.dim_x,
        dim_y: item.dim_y ?? existing.dim_y,
        dim_z: item.dim_z ?? existing.dim_z,
        file_size: item.file_size ?? existing.file_size,
        id: existing.id
      });
      return this.getById(existing.id);
    }

    const ins = this.db.prepare(`
      INSERT INTO stl_models (file_path, filename, category, format, triangle_count, dim_x, dim_y, dim_z, file_size)
      VALUES (@file_path, @filename, @category, @format, @triangle_count, @dim_x, @dim_y, @dim_z, @file_size)
    `);
    const info = ins.run({
      file_path: item.file_path,
      filename: item.filename || '',
      category: item.category || '',
      format: item.format || 'binary',
      triangle_count: item.triangle_count || 0,
      dim_x: item.dim_x || 0,
      dim_y: item.dim_y || 0,
      dim_z: item.dim_z || 0,
      file_size: item.file_size || 0
    });
    return this.getById(info.lastInsertRowid);
  }

  upsertMany(items) {
    const fn = this.db.transaction((list) => {
      const results = [];
      for (const item of list) {
        results.push(this.upsert(item));
      }
      return results;
    });
    return fn(items);
  }

  update(id, updates = {}) {
    const allowed = ['filename', 'category', 'tags', 'notes', 'favorite', 'thumbnail_path',
                     'format', 'triangle_count', 'dim_x', 'dim_y', 'dim_z', 'file_size'];
    const set = [];
    const params = { id };
    for (const key of allowed) {
      if (Object.prototype.hasOwnProperty.call(updates, key)) {
        set.push(`${key} = @${key}`);
        params[key] = updates[key];
      }
    }
    if (!set.length) return this.getById(id);
    this.db.prepare(`UPDATE stl_models SET ${set.join(', ')} WHERE id = @id`).run(params);
    return this.getById(id);
  }

  remove(id) {
    const model = this.getById(id);
    if (model && model.thumbnail_path) {
      try { fs.unlinkSync(model.thumbnail_path); } catch (_) {}
    }
    return this.db.prepare('DELETE FROM stl_models WHERE id = ?').run(id);
  }

  toggleFavorite(id) {
    this.db.prepare('UPDATE stl_models SET favorite = CASE WHEN favorite=1 THEN 0 ELSE 1 END WHERE id = ?').run(id);
    return this.getById(id);
  }

  bulkSetCategory(ids, category) {
    if (!ids.length) return 0;
    const params = { category };
    const placeholders = ids.map((_, i) => `@id${i}`);
    ids.forEach((id, i) => (params[`id${i}`] = id));
    const info = this.db.prepare(`UPDATE stl_models SET category = @category WHERE id IN (${placeholders.join(',')})`).run(params);
    return info.changes || 0;
  }

  bulkSetTags(ids, tags) {
    if (!ids.length) return 0;
    const params = { tags };
    const placeholders = ids.map((_, i) => `@id${i}`);
    ids.forEach((id, i) => (params[`id${i}`] = id));
    const info = this.db.prepare(`UPDATE stl_models SET tags = @tags WHERE id IN (${placeholders.join(',')})`).run(params);
    return info.changes || 0;
  }

  bulkDelete(ids) {
    if (!ids.length) return 0;
    // Delete thumbnails first
    for (const id of ids) {
      const m = this.getById(id);
      if (m && m.thumbnail_path) {
        try { fs.unlinkSync(m.thumbnail_path); } catch (_) {}
      }
    }
    const params = {};
    const placeholders = ids.map((_, i) => `@id${i}`);
    ids.forEach((id, i) => (params[`id${i}`] = id));
    const info = this.db.prepare(`DELETE FROM stl_models WHERE id IN (${placeholders.join(',')})`).run(params);
    return info.changes || 0;
  }

  categories() {
    return this.db.prepare(`
      SELECT COALESCE(NULLIF(category,''),'Uncategorized') AS category, COUNT(*) AS count
      FROM stl_models
      GROUP BY COALESCE(NULLIF(category,''),'Uncategorized')
      ORDER BY category COLLATE NOCASE
    `).all();
  }
}

module.exports = { StlCatalogDB };

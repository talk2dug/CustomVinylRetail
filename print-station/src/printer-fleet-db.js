const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function getDbPath(app) {
  const base = path.join(app.getPath('userData'), 'printer-fleet');
  ensureDir(base);
  return path.join(base, 'fleet.db');
}

function openDb(app) {
  const dbPath = getDbPath(app);
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS printers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      model TEXT,
      api_url TEXT NOT NULL,
      api_key TEXT,
      has_multicolor INTEGER DEFAULT 0,
      build_width INTEGER DEFAULT 220,
      build_depth INTEGER DEFAULT 220,
      build_height INTEGER DEFAULT 250,
      loaded_material TEXT,
      loaded_color TEXT,
      active INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_printers_active ON printers(active);
    CREATE INDEX IF NOT EXISTS idx_printers_name ON printers(name);
    CREATE INDEX IF NOT EXISTS idx_printers_api_url ON printers(api_url);

    CREATE TABLE IF NOT EXISTS print_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      printer_id INTEGER NOT NULL,
      filename TEXT NOT NULL,
      status TEXT DEFAULT 'queued',
      progress REAL DEFAULT 0,
      started_at TEXT,
      completed_at TEXT,
      print_duration REAL,
      shopify_order_id TEXT,
      error_message TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (printer_id) REFERENCES printers(id)
    );
    CREATE INDEX IF NOT EXISTS idx_print_jobs_printer ON print_jobs(printer_id);
    CREATE INDEX IF NOT EXISTS idx_print_jobs_status ON print_jobs(status);
    CREATE INDEX IF NOT EXISTS idx_print_jobs_order ON print_jobs(shopify_order_id);
  `);

  db.exec(`
    CREATE TRIGGER IF NOT EXISTS trg_printers_updated
      AFTER UPDATE ON printers
      BEGIN
        UPDATE printers SET updated_at = datetime('now') WHERE id = NEW.id;
      END;
  `);

  // Migration: add ace_slots column (JSON text for 4-slot ACE config)
  try {
    db.exec(`ALTER TABLE printers ADD COLUMN ace_slots TEXT DEFAULT '[]'`);
  } catch (_) {
    // Column already exists
  }

  return db;
}

class PrinterFleetDB {
  constructor(app) {
    this.app = app;
    this.db = openDb(app);
  }

  close() {
    try { this.db.close(); } catch (_) {}
  }

  // ---- Printers ----

  getPrinter(id) {
    return this.db.prepare('SELECT * FROM printers WHERE id = ?').get(id) || null;
  }

  getPrinterByUrl(apiUrl) {
    return this.db.prepare('SELECT * FROM printers WHERE api_url = ?').get(apiUrl) || null;
  }

  listPrinters({ active, search } = {}) {
    const clauses = [];
    const params = {};

    if (active !== undefined) {
      clauses.push('active = @active');
      params.active = active ? 1 : 0;
    }
    if (search) {
      clauses.push('(name LIKE @q OR model LIKE @q)');
      params.q = `%${search}%`;
    }

    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    return this.db.prepare(`SELECT * FROM printers ${where} ORDER BY name COLLATE NOCASE`).all(params);
  }

  upsertPrinter(printer) {
    const existing = printer.api_url ? this.getPrinterByUrl(printer.api_url) : null;

    if (existing) {
      const allowed = ['name', 'model', 'api_url', 'api_key', 'has_multicolor',
        'build_width', 'build_depth', 'build_height', 'loaded_material', 'loaded_color', 'active', 'ace_slots'];
      const set = [];
      const params = { id: existing.id };
      for (const key of allowed) {
        if (Object.prototype.hasOwnProperty.call(printer, key)) {
          set.push(`${key} = @${key}`);
          params[key] = printer[key];
        }
      }
      if (set.length) {
        this.db.prepare(`UPDATE printers SET ${set.join(', ')} WHERE id = @id`).run(params);
      }
      return this.getPrinter(existing.id);
    }

    const ins = this.db.prepare(`
      INSERT INTO printers (name, model, api_url, api_key, has_multicolor,
        build_width, build_depth, build_height, loaded_material, loaded_color, active, ace_slots)
      VALUES (@name, @model, @api_url, @api_key, @has_multicolor,
        @build_width, @build_depth, @build_height, @loaded_material, @loaded_color, @active, @ace_slots)
    `);
    const info = ins.run({
      name: printer.name || 'Unnamed Printer',
      model: printer.model || '',
      api_url: printer.api_url,
      api_key: printer.api_key || null,
      has_multicolor: printer.has_multicolor ? 1 : 0,
      build_width: printer.build_width || 220,
      build_depth: printer.build_depth || 220,
      build_height: printer.build_height || 250,
      loaded_material: printer.loaded_material || null,
      loaded_color: printer.loaded_color || null,
      active: printer.active !== undefined ? (printer.active ? 1 : 0) : 1,
      ace_slots: printer.ace_slots || '[]'
    });
    return this.getPrinter(info.lastInsertRowid);
  }

  updatePrinter(id, updates = {}) {
    const allowed = ['name', 'model', 'api_url', 'api_key', 'has_multicolor',
      'build_width', 'build_depth', 'build_height', 'loaded_material', 'loaded_color', 'active', 'ace_slots'];
    const set = [];
    const params = { id };
    for (const key of allowed) {
      if (Object.prototype.hasOwnProperty.call(updates, key)) {
        set.push(`${key} = @${key}`);
        params[key] = updates[key];
      }
    }
    if (!set.length) return this.getPrinter(id);
    this.db.prepare(`UPDATE printers SET ${set.join(', ')} WHERE id = @id`).run(params);
    return this.getPrinter(id);
  }

  removePrinter(id) {
    // Delete associated jobs first
    this.db.prepare('DELETE FROM print_jobs WHERE printer_id = ?').run(id);
    return this.db.prepare('DELETE FROM printers WHERE id = ?').run(id);
  }

  // ---- Print Jobs ----

  getJob(id) {
    return this.db.prepare(`
      SELECT j.*, p.name AS printer_name, p.model AS printer_model
      FROM print_jobs j
      LEFT JOIN printers p ON p.id = j.printer_id
      WHERE j.id = ?
    `).get(id) || null;
  }

  listJobs({ printerId, status, limit = 50, offset = 0 } = {}) {
    const clauses = [];
    const params = {};

    if (printerId) {
      clauses.push('j.printer_id = @printerId');
      params.printerId = printerId;
    }
    if (status) {
      clauses.push('j.status = @status');
      params.status = status;
    }

    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    return this.db.prepare(`
      SELECT j.*, p.name AS printer_name, p.model AS printer_model
      FROM print_jobs j
      LEFT JOIN printers p ON p.id = j.printer_id
      ${where}
      ORDER BY j.created_at DESC
      LIMIT @limit OFFSET @offset
    `).all({ ...params, limit, offset });
  }

  createJob(job) {
    const ins = this.db.prepare(`
      INSERT INTO print_jobs (printer_id, filename, status, progress, started_at, shopify_order_id)
      VALUES (@printer_id, @filename, @status, @progress, @started_at, @shopify_order_id)
    `);
    const info = ins.run({
      printer_id: job.printer_id,
      filename: job.filename || '',
      status: job.status || 'queued',
      progress: job.progress || 0,
      started_at: job.started_at || null,
      shopify_order_id: job.shopify_order_id || null
    });
    return this.getJob(info.lastInsertRowid);
  }

  updateJob(id, updates = {}) {
    const allowed = ['status', 'progress', 'started_at', 'completed_at', 'print_duration', 'error_message'];
    const set = [];
    const params = { id };
    for (const key of allowed) {
      if (Object.prototype.hasOwnProperty.call(updates, key)) {
        set.push(`${key} = @${key}`);
        params[key] = updates[key];
      }
    }
    if (!set.length) return this.getJob(id);
    this.db.prepare(`UPDATE print_jobs SET ${set.join(', ')} WHERE id = @id`).run(params);
    return this.getJob(id);
  }

  getActiveJobs() {
    return this.db.prepare(`
      SELECT j.*, p.name AS printer_name, p.model AS printer_model
      FROM print_jobs j
      LEFT JOIN printers p ON p.id = j.printer_id
      WHERE j.status IN ('printing', 'paused', 'queued')
      ORDER BY j.created_at DESC
    `).all();
  }

  getJobHistory(printerId, limit = 20) {
    return this.db.prepare(`
      SELECT * FROM print_jobs
      WHERE printer_id = @printerId
      ORDER BY created_at DESC
      LIMIT @limit
    `).all({ printerId, limit });
  }

  getJobStats() {
    const stats = this.db.prepare(`
      SELECT status, COUNT(*) AS count FROM print_jobs GROUP BY status
    `).all();
    const total = this.db.prepare('SELECT COUNT(*) AS count FROM print_jobs').get();
    const today = this.db.prepare(`
      SELECT COUNT(*) AS count FROM print_jobs
      WHERE created_at >= date('now')
    `).get();
    return {
      byStatus: stats.reduce((acc, r) => { acc[r.status] = r.count; return acc; }, {}),
      total: total.count,
      today: today.count
    };
  }
}

module.exports = { PrinterFleetDB };

import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

export class SQLiteStore {
  constructor() {
    this.dbPath = process.env.SQLITE_PATH || './data/brain.db';
    this.db = null;
  }

  async init() {
    // Ensure directory exists
    const dir = path.dirname(this.dbPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    this.db = new Database(this.dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');

    // Create tables
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        content TEXT NOT NULL,
        type TEXT DEFAULT 'event',
        source_agent TEXT,
        client_id TEXT DEFAULT 'global',
        category TEXT DEFAULT 'episodic',
        importance TEXT DEFAULT 'medium',
        content_hash TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS facts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        key TEXT UNIQUE NOT NULL,
        value TEXT NOT NULL,
        content TEXT,
        source_agent TEXT,
        client_id TEXT DEFAULT 'global',
        category TEXT DEFAULT 'semantic',
        importance TEXT DEFAULT 'medium',
        content_hash TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS statuses (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        subject TEXT UNIQUE NOT NULL,
        status TEXT NOT NULL,
        source_agent TEXT,
        client_id TEXT DEFAULT 'global',
        category TEXT DEFAULT 'episodic',
        importance TEXT DEFAULT 'medium',
        content_hash TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_events_source ON events(source_agent);
      CREATE INDEX IF NOT EXISTS idx_events_created ON events(created_at);
      CREATE INDEX IF NOT EXISTS idx_events_client ON events(client_id);
      CREATE INDEX IF NOT EXISTS idx_facts_key ON facts(key);
      CREATE INDEX IF NOT EXISTS idx_facts_client ON facts(client_id);
      CREATE INDEX IF NOT EXISTS idx_statuses_subject ON statuses(subject);
    `);

    console.log(`[sqlite] Database ready at ${this.dbPath}`);
  }

  createEvent(data) {
    const stmt = this.db.prepare(`
      INSERT INTO events (content, type, source_agent, client_id, category, importance, content_hash, created_at)
      VALUES (@content, @type, @source_agent, @client_id, @category, @importance, @content_hash, @created_at)
    `);
    const result = stmt.run({
      content: data.content,
      type: data.type || 'event',
      source_agent: data.source_agent || null,
      client_id: data.client_id || 'global',
      category: data.category || 'episodic',
      importance: data.importance || 'medium',
      content_hash: data.content_hash || null,
      created_at: data.created_at || new Date().toISOString(),
    });
    return { id: result.lastInsertRowid };
  }

  listEvents(filters = {}) {
    let sql = 'SELECT * FROM events WHERE 1=1';
    const params = {};

    if (filters.source_agent) { sql += ' AND source_agent = @source_agent'; params.source_agent = filters.source_agent; }
    if (filters.category) { sql += ' AND category = @category'; params.category = filters.category; }
    if (filters.client_id) { sql += ' AND client_id = @client_id'; params.client_id = filters.client_id; }
    if (filters.since) { sql += ' AND created_at >= @since'; params.since = filters.since; }

    sql += ' ORDER BY created_at DESC LIMIT 50';
    const results = this.db.prepare(sql).all(params);
    return { results };
  }

  upsertFact(data) {
    const now = new Date().toISOString();
    const existing = this.db.prepare('SELECT id FROM facts WHERE key = @key').get({ key: data.key });

    if (existing) {
      this.db.prepare(`
        UPDATE facts SET value = @value, content = @content, source_agent = @source_agent,
        client_id = @client_id, category = @category, importance = @importance,
        content_hash = @content_hash, updated_at = @updated_at WHERE key = @key
      `).run({
        key: data.key,
        value: data.value || data.content,
        content: data.content,
        source_agent: data.source_agent || null,
        client_id: data.client_id || 'global',
        category: data.category || 'semantic',
        importance: data.importance || 'medium',
        content_hash: data.content_hash || null,
        updated_at: now,
      });
      return { id: existing.id, updated: true };
    }

    const result = this.db.prepare(`
      INSERT INTO facts (key, value, content, source_agent, client_id, category, importance, content_hash, created_at, updated_at)
      VALUES (@key, @value, @content, @source_agent, @client_id, @category, @importance, @content_hash, @created_at, @updated_at)
    `).run({
      key: data.key,
      value: data.value || data.content,
      content: data.content,
      source_agent: data.source_agent || null,
      client_id: data.client_id || 'global',
      category: data.category || 'semantic',
      importance: data.importance || 'medium',
      content_hash: data.content_hash || null,
      created_at: data.created_at || now,
      updated_at: now,
    });
    return { id: result.lastInsertRowid, created: true };
  }

  listFacts(filters = {}) {
    let sql = 'SELECT * FROM facts WHERE 1=1';
    const params = {};

    if (filters.source_agent) { sql += ' AND source_agent = @source_agent'; params.source_agent = filters.source_agent; }
    if (filters.category) { sql += ' AND category = @category'; params.category = filters.category; }
    if (filters.client_id) { sql += ' AND client_id = @client_id'; params.client_id = filters.client_id; }
    if (filters.key) { sql += ' AND key LIKE @key'; params.key = `%${filters.key}%`; }

    sql += ' ORDER BY updated_at DESC LIMIT 50';
    const results = this.db.prepare(sql).all(params);
    return { results };
  }

  upsertStatus(data) {
    const now = new Date().toISOString();
    const existing = this.db.prepare('SELECT id FROM statuses WHERE subject = @subject').get({ subject: data.subject });

    if (existing) {
      this.db.prepare(`
        UPDATE statuses SET status = @status, source_agent = @source_agent,
        client_id = @client_id, category = @category, importance = @importance,
        content_hash = @content_hash, updated_at = @updated_at WHERE subject = @subject
      `).run({
        subject: data.subject,
        status: data.status,
        source_agent: data.source_agent || null,
        client_id: data.client_id || 'global',
        category: data.category || 'episodic',
        importance: data.importance || 'medium',
        content_hash: data.content_hash || null,
        updated_at: now,
      });
      return { id: existing.id, updated: true };
    }

    const result = this.db.prepare(`
      INSERT INTO statuses (subject, status, source_agent, client_id, category, importance, content_hash, created_at, updated_at)
      VALUES (@subject, @status, @source_agent, @client_id, @category, @importance, @content_hash, @created_at, @updated_at)
    `).run({
      subject: data.subject,
      status: data.status,
      source_agent: data.source_agent || null,
      client_id: data.client_id || 'global',
      category: data.category || 'episodic',
      importance: data.importance || 'medium',
      content_hash: data.content_hash || null,
      created_at: data.created_at || now,
      updated_at: now,
    });
    return { id: result.lastInsertRowid, created: true };
  }

  listStatuses(filters = {}) {
    let sql = 'SELECT * FROM statuses WHERE 1=1';
    const params = {};

    if (filters.source_agent) { sql += ' AND source_agent = @source_agent'; params.source_agent = filters.source_agent; }
    if (filters.category) { sql += ' AND category = @category'; params.category = filters.category; }
    if (filters.subject) { sql += ' AND subject LIKE @subject'; params.subject = `%${filters.subject}%`; }

    sql += ' ORDER BY updated_at DESC LIMIT 50';
    const results = this.db.prepare(sql).all(params);
    return { results };
  }
}

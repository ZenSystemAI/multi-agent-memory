import pg from 'pg';

export class PostgresStore {
  constructor() {
    this.url = process.env.POSTGRES_URL || 'postgresql://localhost:5432/shared_brain';
    this.pool = null;
  }

  async init() {
    this.pool = new pg.Pool({ connectionString: this.url });

    // Create tables
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS events (
        id SERIAL PRIMARY KEY,
        content TEXT NOT NULL,
        type TEXT DEFAULT 'event',
        source_agent TEXT,
        client_id TEXT DEFAULT 'global',
        category TEXT DEFAULT 'episodic',
        importance TEXT DEFAULT 'medium',
        content_hash TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS facts (
        id SERIAL PRIMARY KEY,
        key TEXT UNIQUE NOT NULL,
        value TEXT NOT NULL,
        content TEXT,
        source_agent TEXT,
        client_id TEXT DEFAULT 'global',
        category TEXT DEFAULT 'semantic',
        importance TEXT DEFAULT 'medium',
        content_hash TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS statuses (
        id SERIAL PRIMARY KEY,
        subject TEXT UNIQUE NOT NULL,
        status TEXT NOT NULL,
        source_agent TEXT,
        client_id TEXT DEFAULT 'global',
        category TEXT DEFAULT 'episodic',
        importance TEXT DEFAULT 'medium',
        content_hash TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_events_source ON events(source_agent);
      CREATE INDEX IF NOT EXISTS idx_events_created ON events(created_at);
      CREATE INDEX IF NOT EXISTS idx_events_client ON events(client_id);
      CREATE INDEX IF NOT EXISTS idx_facts_key ON facts(key);
      CREATE INDEX IF NOT EXISTS idx_facts_client ON facts(client_id);
      CREATE INDEX IF NOT EXISTS idx_statuses_subject ON statuses(subject);
    `);

    console.log(`[postgres] Database ready`);
  }

  async createEvent(data) {
    const result = await this.pool.query(
      `INSERT INTO events (content, type, source_agent, client_id, category, importance, content_hash, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [data.content, data.type || 'event', data.source_agent, data.client_id || 'global',
       data.category || 'episodic', data.importance || 'medium', data.content_hash,
       data.created_at || new Date().toISOString()]
    );
    return { id: result.rows[0].id };
  }

  async listEvents(filters = {}) {
    let sql = 'SELECT * FROM events WHERE 1=1';
    const params = [];
    let i = 1;

    if (filters.source_agent) { sql += ` AND source_agent = $${i++}`; params.push(filters.source_agent); }
    if (filters.category) { sql += ` AND category = $${i++}`; params.push(filters.category); }
    if (filters.client_id) { sql += ` AND client_id = $${i++}`; params.push(filters.client_id); }
    if (filters.since) { sql += ` AND created_at >= $${i++}`; params.push(filters.since); }

    sql += ' ORDER BY created_at DESC LIMIT 50';
    const result = await this.pool.query(sql, params);
    return { results: result.rows };
  }

  async upsertFact(data) {
    const now = new Date().toISOString();
    const result = await this.pool.query(
      `INSERT INTO facts (key, value, content, source_agent, client_id, category, importance, content_hash, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (key) DO UPDATE SET
         value = EXCLUDED.value, content = EXCLUDED.content, source_agent = EXCLUDED.source_agent,
         client_id = EXCLUDED.client_id, category = EXCLUDED.category, importance = EXCLUDED.importance,
         content_hash = EXCLUDED.content_hash, updated_at = EXCLUDED.updated_at
       RETURNING id`,
      [data.key, data.value || data.content, data.content, data.source_agent,
       data.client_id || 'global', data.category || 'semantic', data.importance || 'medium',
       data.content_hash, data.created_at || now, now]
    );
    return { id: result.rows[0].id };
  }

  async listFacts(filters = {}) {
    let sql = 'SELECT * FROM facts WHERE 1=1';
    const params = [];
    let i = 1;

    if (filters.source_agent) { sql += ` AND source_agent = $${i++}`; params.push(filters.source_agent); }
    if (filters.category) { sql += ` AND category = $${i++}`; params.push(filters.category); }
    if (filters.client_id) { sql += ` AND client_id = $${i++}`; params.push(filters.client_id); }
    if (filters.key) { sql += ` AND key ILIKE $${i++}`; params.push(`%${filters.key}%`); }

    sql += ' ORDER BY updated_at DESC LIMIT 50';
    const result = await this.pool.query(sql, params);
    return { results: result.rows };
  }

  async upsertStatus(data) {
    const now = new Date().toISOString();
    const result = await this.pool.query(
      `INSERT INTO statuses (subject, status, source_agent, client_id, category, importance, content_hash, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (subject) DO UPDATE SET
         status = EXCLUDED.status, source_agent = EXCLUDED.source_agent,
         client_id = EXCLUDED.client_id, category = EXCLUDED.category, importance = EXCLUDED.importance,
         content_hash = EXCLUDED.content_hash, updated_at = EXCLUDED.updated_at
       RETURNING id`,
      [data.subject, data.status, data.source_agent, data.client_id || 'global',
       data.category || 'episodic', data.importance || 'medium', data.content_hash,
       data.created_at || now, now]
    );
    return { id: result.rows[0].id };
  }

  async listStatuses(filters = {}) {
    let sql = 'SELECT * FROM statuses WHERE 1=1';
    const params = [];
    let i = 1;

    if (filters.source_agent) { sql += ` AND source_agent = $${i++}`; params.push(filters.source_agent); }
    if (filters.category) { sql += ` AND category = $${i++}`; params.push(filters.category); }
    if (filters.subject) { sql += ` AND subject ILIKE $${i++}`; params.push(`%${filters.subject}%`); }

    sql += ' ORDER BY updated_at DESC LIMIT 50';
    const result = await this.pool.query(sql, params);
    return { results: result.rows };
  }
}

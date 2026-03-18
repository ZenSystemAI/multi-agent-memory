// Entity extraction and linking — fast-path (no LLM calls)
// Extracts entities from memory content at write time using regex + alias cache

const KNOWN_TECH = {
  'postgres': 'PostgreSQL', 'postgresql': 'PostgreSQL', 'psql': 'PostgreSQL',
  'mysql': 'MySQL', 'mariadb': 'MariaDB',
  'redis': 'Redis', 'docker': 'Docker', 'kubernetes': 'Kubernetes', 'k8s': 'Kubernetes',
  'n8n': 'n8n', 'qdrant': 'Qdrant', 'sqlite': 'SQLite',
  'express': 'Express.js', 'nginx': 'Nginx', 'apache': 'Apache', 'caddy': 'Caddy',
  'nodejs': 'Node.js', 'node.js': 'Node.js',
  'react': 'React', 'nextjs': 'Next.js', 'next.js': 'Next.js', 'vue': 'Vue.js', 'nuxt': 'Nuxt',
  'python': 'Python', 'javascript': 'JavaScript', 'typescript': 'TypeScript',
  'git': 'Git', 'github': 'GitHub', 'gitlab': 'GitLab',
  'baserow': 'Baserow', 'hostinger': 'Hostinger', 'vercel': 'Vercel', 'netlify': 'Netlify',
  'claude': 'Claude', 'chatgpt': 'ChatGPT', 'openai': 'OpenAI', 'anthropic': 'Anthropic',
  'gemini': 'Gemini', 'ollama': 'Ollama', 'openclaw': 'OpenClaw',
  'google': 'Google', 'cloudflare': 'Cloudflare', 'aws': 'AWS', 'azure': 'Azure',
  'shopify': 'Shopify', 'woocommerce': 'WooCommerce', 'wordpress': 'WordPress', 'wp': 'WordPress',
  'ahrefs': 'Ahrefs', 'semrush': 'SEMrush', 'dataforseo': 'DataForSEO',
  'stripe': 'Stripe', 'twilio': 'Twilio', 'sendgrid': 'SendGrid',
  'canva': 'Canva', 'figma': 'Figma', 'slack': 'Slack',
  'mongodb': 'MongoDB', 'neo4j': 'Neo4j', 'elasticsearch': 'Elasticsearch',
  'graphql': 'GraphQL',
  'linux': 'Linux', 'ubuntu': 'Ubuntu', 'debian': 'Debian',
  'polylang': 'Polylang', 'yoast': 'Yoast', 'acf': 'ACF',
};

const DOMAIN_REGEX = /\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:com|ca|org|net|io|dev|app|co|fr|uk|de|ai)\b/gi;
const QUOTED_NAME_REGEX = /[""`]([^"""`]{3,60})[""`]/g;
const CAPITALIZED_PHRASE_REGEX = /\b([A-Z][a-z]{2,}(?:\s+[A-Z][a-z]{2,})+)\b/g;

const SKIP_PHRASES = new Set([
  'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday',
  'January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December',
  'Error Trigger', 'Code Node', 'HTTP Request', 'The Problem',
  'What Was', 'How To', 'Set Up', 'Get Started',
]);

// In-memory alias cache: lowercase alias -> { entityId, canonicalName, entityType }
let aliasCache = new Map();

export function loadAliasCache(entries) {
  aliasCache = new Map();
  // Pre-seed with KNOWN_TECH so tech entities always resolve, even before first consolidation
  for (const [alias, canonical] of Object.entries(KNOWN_TECH)) {
    aliasCache.set(alias.toLowerCase(), {
      entityId: null, // no DB id yet — extraction will still match by canonical name
      canonicalName: canonical,
      entityType: 'technology',
    });
  }
  // Overlay DB aliases (these take precedence — they have real entity IDs)
  for (const e of entries) {
    aliasCache.set(e.alias.toLowerCase(), {
      entityId: e.entity_id,
      canonicalName: e.canonical_name,
      entityType: e.entity_type,
    });
  }
  console.log(`[entities] Alias cache loaded: ${aliasCache.size} entries (${entries.length} from DB, ${Object.keys(KNOWN_TECH).length} built-in)`);
}

export function addToAliasCache(alias, entityId, canonicalName, entityType) {
  aliasCache.set(alias.toLowerCase(), { entityId, canonicalName, entityType });
}

export function extractEntities(text, clientId, sourceAgent) {
  const entities = [];
  const seen = new Set();

  function add(name, type, role) {
    const key = `${name.toLowerCase()}::${role}`;
    if (seen.has(key)) return;
    seen.add(key);

    // Check alias cache for canonical resolution
    const cached = aliasCache.get(name.toLowerCase());
    if (cached) {
      entities.push({ name: cached.canonicalName, type: cached.entityType, role, entityId: cached.entityId });
      return;
    }
    entities.push({ name, type, role, entityId: null });
  }

  // 1. client_id is always an entity
  if (clientId && clientId !== 'global') {
    add(clientId, 'client', 'about');
  }

  // 2. source_agent is always an entity
  if (sourceAgent) {
    add(sourceAgent, 'agent', 'source');
  }

  // 3. Domain names
  const domains = text.match(DOMAIN_REGEX) || [];
  for (const domain of domains) {
    add(domain.toLowerCase(), 'domain', 'mentioned');
  }

  // 4. Known technology names (word-boundary)
  const lowerText = ` ${text.toLowerCase()} `;
  for (const [keyword, canonical] of Object.entries(KNOWN_TECH)) {
    // Escape regex special chars and check word boundaries
    const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`\\b${escaped}\\b`, 'i');
    if (re.test(lowerText)) {
      add(canonical, 'technology', 'mentioned');
    }
  }

  // 5. Quoted/backtick names (likely workflow or specific names)
  let match;
  QUOTED_NAME_REGEX.lastIndex = 0;
  while ((match = QUOTED_NAME_REGEX.exec(text)) !== null) {
    const name = match[1].trim();
    if (name.length >= 3 && name.length <= 60) {
      const cached = aliasCache.get(name.toLowerCase());
      add(cached?.canonicalName || name, cached?.entityType || 'workflow', 'mentioned');
    }
  }

  // 6. Capitalized multi-word phrases (proper nouns)
  CAPITALIZED_PHRASE_REGEX.lastIndex = 0;
  while ((match = CAPITALIZED_PHRASE_REGEX.exec(text)) !== null) {
    const phrase = match[1].trim();
    if (SKIP_PHRASES.has(phrase)) continue;
    // Skip if it's already caught by tech dictionary
    if (KNOWN_TECH[phrase.toLowerCase()]) continue;
    const cached = aliasCache.get(phrase.toLowerCase());
    add(cached?.canonicalName || phrase, cached?.entityType || 'person', 'mentioned');
  }

  return entities;
}

/**
 * Link extracted entities to a memory in the structured store.
 * Finds or creates each entity, then creates the memory link.
 * Requires: createEntity, findEntity, linkEntityToMemory from stores/interface.js
 */
export async function linkExtractedEntities(entities, memoryId, storeFns) {
  const { createEntity, findEntity, linkEntityToMemory } = storeFns;
  for (const ent of entities) {
    let entityId = ent.entityId;
    if (!entityId) {
      const found = await findEntity(ent.name);
      if (found) {
        entityId = found.id;
      } else {
        const created = await createEntity({ canonical_name: ent.name, entity_type: ent.type });
        entityId = created.id;
        addToAliasCache(ent.name, entityId, ent.name, ent.type);
      }
    } else {
      // Bump mention count for known entity
      await createEntity({ canonical_name: ent.name, entity_type: ent.type });
    }
    if (entityId) await linkEntityToMemory(entityId, memoryId, ent.role);
  }
}

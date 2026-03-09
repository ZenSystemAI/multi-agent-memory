import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const API_URL = process.env.BRAIN_API_URL || 'http://192.168.18.40:8084';
const API_KEY = process.env.BRAIN_API_KEY || '';

async function apiRequest(path, options = {}) {
  const url = `${API_URL}${path}`;
  const headers = {
    'Content-Type': 'application/json',
    'x-api-key': API_KEY,
    ...options.headers,
  };

  const res = await fetch(url, { ...options, headers });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`API ${options.method || 'GET'} ${path}: ${res.status} ${text}`);
  }
  return res.json();
}

const server = new Server(
  { name: 'shared-brain', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'brain_store',
      description: 'Store a memory in the Shared Brain. Use this to record events (something happened), facts (persistent knowledge), decisions (choices made and why), or status updates (current state of systems/workflows). All agents share this memory.',
      inputSchema: {
        type: 'object',
        properties: {
          type: {
            type: 'string',
            enum: ['event', 'fact', 'decision', 'status'],
            description: 'Memory type. event=something happened (append-only), fact=persistent knowledge (upsertable), decision=choice made and why (append-only), status=current state (update in place)',
          },
          content: {
            type: 'string',
            description: 'The memory content. Be specific and include context.',
          },
          source_agent: {
            type: 'string',
            enum: ['claude-code', 'antigravity', 'morpheus', 'n8n'],
            description: 'Which agent is storing this memory',
          },
          client_id: {
            type: 'string',
            description: 'Client slug (e.g. "jetloans") or "global" for system-wide memories. Default: global',
          },
          category: {
            type: 'string',
            enum: ['semantic', 'episodic', 'procedural'],
            description: 'semantic=concepts/knowledge, episodic=events/experiences, procedural=how-to/processes',
          },
          importance: {
            type: 'string',
            enum: ['critical', 'high', 'medium', 'low'],
            description: 'How important is this memory. Default: medium',
          },
          key: {
            type: 'string',
            description: 'For facts only: unique key for upsert (e.g. "jetloans-gsc-status")',
          },
          subject: {
            type: 'string',
            description: 'For status only: what system/workflow this status is about',
          },
          status_value: {
            type: 'string',
            description: 'For status only: the current status value',
          },
        },
        required: ['type', 'content', 'source_agent'],
      },
    },
    {
      name: 'brain_search',
      description: 'Semantic search across all shared memories from all agents. Use natural language queries like "what do we know about the newsletter pipeline" or "recent changes to n8n workflows".',
      inputSchema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Natural language search query',
          },
          type: {
            type: 'string',
            enum: ['event', 'fact', 'decision', 'status'],
            description: 'Filter by memory type (optional)',
          },
          source_agent: {
            type: 'string',
            description: 'Filter by agent (optional)',
          },
          client_id: {
            type: 'string',
            description: 'Filter by client (optional)',
          },
          limit: {
            type: 'number',
            description: 'Max results (default 10)',
          },
        },
        required: ['query'],
      },
    },
    {
      name: 'brain_briefing',
      description: 'Get a session briefing: what happened since a given time across all agents. Use this at the start of a session to catch up on what other agents did. Excludes entries from the requesting agent by default.',
      inputSchema: {
        type: 'object',
        properties: {
          since: {
            type: 'string',
            description: 'ISO 8601 timestamp. Get events since this time. Example: 2026-03-09T00:00:00Z',
          },
          agent: {
            type: 'string',
            description: 'The requesting agent (entries from this agent are excluded). Default: claude-code',
          },
          include: {
            type: 'string',
            enum: ['all'],
            description: 'Set to "all" to include own entries in briefing',
          },
        },
        required: ['since'],
      },
    },
    {
      name: 'brain_query',
      description: 'Structured query of shared memories via Baserow. Query facts by key, statuses by subject, or events by time range. Use brain_search for semantic queries instead.',
      inputSchema: {
        type: 'object',
        properties: {
          type: {
            type: 'string',
            enum: ['events', 'facts', 'statuses'],
            description: 'What to query',
          },
          source_agent: { type: 'string', description: 'Filter by agent' },
          category: { type: 'string', description: 'Filter by category' },
          client_id: { type: 'string', description: 'Filter by client' },
          since: { type: 'string', description: 'For events: ISO timestamp' },
          key: { type: 'string', description: 'For facts: search by key' },
          subject: { type: 'string', description: 'For statuses: search by subject' },
        },
        required: ['type'],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    let result;

    switch (name) {
      case 'brain_store':
        result = await apiRequest('/memory', {
          method: 'POST',
          body: JSON.stringify({
            type: args.type,
            content: args.content,
            source_agent: args.source_agent || 'claude-code',
            client_id: args.client_id,
            category: args.category,
            importance: args.importance,
            key: args.key,
            subject: args.subject,
            status_value: args.status_value,
          }),
        });
        break;

      case 'brain_search': {
        const params = new URLSearchParams({ q: args.query });
        if (args.type) params.append('type', args.type);
        if (args.source_agent) params.append('source_agent', args.source_agent);
        if (args.client_id) params.append('client_id', args.client_id);
        if (args.limit) params.append('limit', String(args.limit));
        result = await apiRequest(`/memory/search?${params}`);
        break;
      }

      case 'brain_briefing': {
        const params = new URLSearchParams({ since: args.since });
        if (args.agent) params.append('agent', args.agent);
        if (args.include) params.append('include', args.include);
        result = await apiRequest(`/briefing?${params}`);
        break;
      }

      case 'brain_query': {
        const params = new URLSearchParams({ type: args.type });
        if (args.source_agent) params.append('source_agent', args.source_agent);
        if (args.category) params.append('category', args.category);
        if (args.client_id) params.append('client_id', args.client_id);
        if (args.since) params.append('since', args.since);
        if (args.key) params.append('key', args.key);
        if (args.subject) params.append('subject', args.subject);
        result = await apiRequest(`/memory/query?${params}`);
        break;
      }

      default:
        return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
    }

    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  } catch (err) {
    return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[shared-brain-mcp] Connected');
}

main().catch(console.error);

# @zensystemai/multi-agent-memory-mcp

MCP server for [Multi-Agent Memory](https://github.com/ZenSystemAI/multi-agent-memory) — gives Claude Code, Cursor, and other MCP-compatible AI tools access to a shared memory system that works across agents and machines.

## Prerequisites

This package connects to the Multi-Agent Memory API. You need to run that first:

```bash
git clone https://github.com/ZenSystemAI/multi-agent-memory.git
cd multi-agent-memory
cp .env.example .env  # Set BRAIN_API_KEY, QDRANT_URL, QDRANT_API_KEY
docker compose up -d
```

## Installation

```bash
npm install -g @zensystemai/multi-agent-memory-mcp
```

## Configuration

### Claude Code (`~/.claude.json`)

```json
{
  "mcpServers": {
    "shared-brain": {
      "command": "multi-agent-memory-mcp",
      "env": {
        "BRAIN_API_URL": "http://localhost:8084",
        "BRAIN_API_KEY": "your-api-key"
      }
    }
  }
}
```

### Cursor / Windsurf (`mcp.json`)

```json
{
  "mcpServers": {
    "shared-brain": {
      "command": "multi-agent-memory-mcp",
      "env": {
        "BRAIN_API_URL": "http://your-server:8084",
        "BRAIN_API_KEY": "your-api-key"
      }
    }
  }
}
```

### Environment Variables

| Variable | Required | Description |
|----------|:--------:|-------------|
| `BRAIN_API_KEY` | Yes | API key set in your `.env` |
| `BRAIN_API_URL` | No | API URL. Default: `http://localhost:8084` |

## Tools

| Tool | Description |
|------|-------------|
| `brain_store` | Store a memory (event, fact, decision, or status) |
| `brain_search` | Semantic search across all memories from all agents |
| `brain_briefing` | Get a session briefing — what happened since a given time |
| `brain_query` | Structured query by type, key, subject, or time range |
| `brain_stats` | Memory health stats (totals, active, decayed, by type) |
| `brain_consolidate` | Trigger or check LLM consolidation |

## Usage Example

Once configured, your AI tool can call these tools directly. For example in Claude Code:

```
brain_briefing since="2026-03-11T00:00:00Z" agent="claude-code"
```

Returns categorized updates from all other agents since yesterday — events, facts, decisions, and status changes.

```
brain_store type="fact" content="Client prefers dark mode UI" source_agent="claude-code" client_id="acme-corp" key="acme-ui-preference"
```

Stores a fact that any other agent (n8n, OpenClaw, Cursor) can retrieve later.

## Memory Types

| Type | Behavior | When to Use |
|------|----------|-------------|
| `event` | Append-only, immutable | "Deployment completed", "Workflow failed" |
| `fact` | Upsert by `key` | Persistent knowledge that gets updated |
| `status` | Update-in-place by `subject` | Current state of a system or workflow |
| `decision` | Append-only | Choices made and why |

## Full Documentation

See the [main repository](https://github.com/ZenSystemAI/multi-agent-memory) for the complete API reference, adapter docs (Bash CLI, n8n, OpenClaw), deployment guide, and architecture overview.

## License

MIT

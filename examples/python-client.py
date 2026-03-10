#!/usr/bin/env python3
"""
Multi-Agent Memory — Minimal Python Client

A lightweight wrapper around the Memory API. No dependencies beyond `requests`.

Usage:
    pip install requests
    python python-client.py

Or import in your own code:
    from python_client import BrainClient
    brain = BrainClient("http://localhost:8084", "your-key")
    brain.store("fact", "The API is running", "my-agent", key="api-status")
"""

import requests
from datetime import datetime, timedelta, timezone


class BrainClient:
    """Minimal client for the Multi-Agent Memory API."""

    def __init__(self, api_url: str, api_key: str):
        self.api_url = api_url.rstrip("/")
        self.session = requests.Session()
        self.session.headers.update({
            "X-Api-Key": api_key,
            "Content-Type": "application/json",
        })

    # ----- Store a memory -----

    def store(
        self,
        memory_type: str,
        content: str,
        source_agent: str,
        client_id: str = "global",
        category: str = "episodic",
        importance: str = "medium",
        key: str | None = None,
        subject: str | None = None,
        status_value: str | None = None,
        metadata: dict | None = None,
    ) -> dict:
        """
        Store a memory in the shared brain.

        Args:
            memory_type: One of 'event', 'fact', 'status', 'decision'.
            content:     The memory text. Be specific and include context.
            source_agent: Identifier for the agent storing this memory.
            client_id:   Project/client slug. Defaults to 'global'.
            category:    'semantic', 'episodic', or 'procedural'.
            importance:  'critical', 'high', 'medium', or 'low'.
            key:         For facts — unique key enabling upsert.
            subject:     For statuses — what system this status is about.
            status_value: For statuses — the current status string.
            metadata:    Optional dict of extra data to attach.

        Returns:
            API response dict with id, type, content_hash, deduplicated, etc.
        """
        payload = {
            "type": memory_type,
            "content": content,
            "source_agent": source_agent,
            "client_id": client_id,
            "category": category,
            "importance": importance,
        }
        if key is not None:
            payload["key"] = key
        if subject is not None:
            payload["subject"] = subject
        if status_value is not None:
            payload["status_value"] = status_value
        if metadata is not None:
            payload["metadata"] = metadata

        resp = self.session.post(f"{self.api_url}/memory", json=payload)
        resp.raise_for_status()
        return resp.json()

    # ----- Semantic search -----

    def search(
        self,
        query: str,
        limit: int = 10,
        memory_type: str | None = None,
        source_agent: str | None = None,
        client_id: str | None = None,
        category: str | None = None,
        include_superseded: bool = False,
    ) -> dict:
        """
        Semantic search across all memories.

        The query is embedded and compared against stored memory vectors.
        Results are ranked by similarity * confidence.

        Returns:
            Dict with 'query', 'count', and 'results' list.
        """
        params = {"q": query, "limit": limit}
        if memory_type:
            params["type"] = memory_type
        if source_agent:
            params["source_agent"] = source_agent
        if client_id:
            params["client_id"] = client_id
        if category:
            params["category"] = category
        if include_superseded:
            params["include_superseded"] = "true"

        resp = self.session.get(f"{self.api_url}/memory/search", params=params)
        resp.raise_for_status()
        return resp.json()

    # ----- Session briefing -----

    def briefing(
        self,
        since: str | datetime | None = None,
        agent: str | None = None,
        include_own: bool = False,
    ) -> dict:
        """
        Get a session briefing — what happened since the given timestamp.

        Entries from the requesting agent are excluded by default (they
        already know what they did). Set include_own=True to include them.

        Args:
            since: ISO 8601 timestamp, or datetime object.
                   Defaults to 24 hours ago.
            agent: The agent requesting the briefing (used for filtering).
            include_own: If True, include the requesting agent's own entries.

        Returns:
            Briefing dict with events, facts_updated, status_changes, decisions.
        """
        if since is None:
            since = datetime.now(timezone.utc) - timedelta(days=1)
        if isinstance(since, datetime):
            since = since.isoformat()

        params = {"since": since}
        if agent:
            params["agent"] = agent
        if include_own:
            params["include"] = "all"

        resp = self.session.get(f"{self.api_url}/briefing", params=params)
        resp.raise_for_status()
        return resp.json()

    # ----- Structured query -----

    def query(
        self,
        memory_type: str = "events",
        key: str | None = None,
        subject: str | None = None,
        since: str | None = None,
        source_agent: str | None = None,
        client_id: str | None = None,
    ) -> dict:
        """
        Structured query against the database backend (SQLite/Postgres/Baserow).

        Use this for exact lookups like 'get fact with key X' or 'list all statuses'.

        Args:
            memory_type: 'events', 'facts', or 'statuses'.
            key:         For facts — filter by key.
            subject:     For statuses — filter by subject.
            since:       For events — filter by timestamp (ISO 8601).
            source_agent: Filter by agent.
            client_id:   Filter by client.

        Returns:
            Dict with 'type', 'count', and 'results' list.
        """
        params = {"type": memory_type}
        if key:
            params["key"] = key
        if subject:
            params["subject"] = subject
        if since:
            params["since"] = since
        if source_agent:
            params["source_agent"] = source_agent
        if client_id:
            params["client_id"] = client_id

        resp = self.session.get(f"{self.api_url}/memory/query", params=params)
        resp.raise_for_status()
        return resp.json()

    # ----- Stats -----

    def stats(self) -> dict:
        """
        Get memory health stats: totals by type, by agent, decay info, etc.
        """
        resp = self.session.get(f"{self.api_url}/stats")
        resp.raise_for_status()
        return resp.json()


# =========================================================================
# Demo — run this file directly to see the client in action
# =========================================================================

if __name__ == "__main__":
    import json
    import os

    API_URL = os.environ.get("BRAIN_API_URL", "http://localhost:8084")
    API_KEY = os.environ.get("BRAIN_API_KEY", "your-key-here")

    brain = BrainClient(API_URL, API_KEY)

    def pretty(label: str, data: dict):
        print(f"\n{'=' * 60}")
        print(f"  {label}")
        print(f"{'=' * 60}")
        print(json.dumps(data, indent=2))

    # --- 1. Store some memories ---

    result = brain.store(
        memory_type="event",
        content="Nightly batch job processed 12,340 records successfully",
        source_agent="python-demo",
        client_id="acme-corp",
        importance="medium",
    )
    pretty("Stored: Event", result)

    result = brain.store(
        memory_type="fact",
        content="The staging environment uses PostgreSQL 16 on staging-db.internal:5432",
        source_agent="python-demo",
        client_id="acme-corp",
        importance="high",
        key="acme-staging-db",
        category="semantic",
    )
    pretty("Stored: Fact (key=acme-staging-db)", result)

    result = brain.store(
        memory_type="decision",
        content="Switched from REST polling to WebSocket push for real-time dashboard updates. "
                "Reduces API calls by ~80% and improves latency from 5s to <200ms.",
        source_agent="python-demo",
        client_id="acme-corp",
        importance="high",
        category="semantic",
    )
    pretty("Stored: Decision", result)

    # --- 2. Semantic search ---

    results = brain.search("database configuration", client_id="acme-corp", limit=5)
    pretty("Search: 'database configuration'", results)

    # --- 3. Session briefing ---

    briefing = brain.briefing(agent="python-demo")
    pretty("Briefing (last 24h, excluding own entries)", briefing)

    # --- 4. Structured query ---

    facts = brain.query(memory_type="facts", key="acme-staging-db")
    pretty("Query: fact by key 'acme-staging-db'", facts)

    # --- 5. Stats ---

    stats = brain.stats()
    pretty("Stats: Memory Health", stats)

    print("\nDone! All operations completed successfully.")

#!/usr/bin/env bash
set -euo pipefail

# memory-query.sh — Query local Qdrant + Shared Brain with conflict resolution
# Shared Brain results take priority over local when facts conflict.

OPENAI_URL="https://api.openai.com/v1/embeddings"
OPENAI_MODEL="text-embedding-3-small"
QDRANT_URL="http://127.0.0.1:6333"
QDRANT_COLLECTION="memories"

if [ -f ~/.openclaw/.env ]; then
  while IFS='=' read -r key value; do
    case "$key" in
      QDRANT_API_KEY|OPENAI_API_KEY|BRAIN_API_KEY|BRAIN_API_URL) export "$key=$value" ;;
    esac
  done < ~/.openclaw/.env
fi

if [ -z "${QDRANT_API_KEY:-}" ]; then
  echo "ERROR: QDRANT_API_KEY not set" >&2
  exit 2
fi

if [ -z "${OPENAI_API_KEY:-}" ]; then
  echo "ERROR: OPENAI_API_KEY not set" >&2
  exit 2
fi

# Shared Brain config
BRAIN_API_URL="${BRAIN_API_URL:-http://localhost:8084}"
BRAIN_AVAILABLE=false
if [ -n "${BRAIN_API_KEY:-}" ] && [ -n "$BRAIN_API_URL" ]; then
  BRAIN_AVAILABLE=true
fi

QUERY=""
CLIENT_ID=""
CATEGORY=""
LIMIT=5

while [[ $# -gt 0 ]]; do
  case $1 in
    --query) QUERY="$2"; shift 2 ;;
    --client_id) CLIENT_ID="$2"; shift 2 ;;
    --category) CATEGORY="$2"; shift 2 ;;
    --limit) LIMIT="$2"; shift 2 ;;
    *) echo "Unknown arg: $1" >&2; exit 1 ;;
  esac
done

if [ -z "$QUERY" ] || [ -z "$CLIENT_ID" ]; then
  echo "ERROR: --query and --client_id are required" >&2
  exit 1
fi

# === Generate embedding ===
EMBED_PAYLOAD=$(jq -n --arg text "search_query: ${QUERY}" --arg model "$OPENAI_MODEL" \
  '{"model": $model, "input": $text, "dimensions": 768}')
EMBED_RESPONSE=$(curl -s --max-time 30 "${OPENAI_URL}" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${OPENAI_API_KEY}" \
  -d "$EMBED_PAYLOAD")

if ! echo "$EMBED_RESPONSE" | jq -e '.data[0].embedding' > /dev/null 2>&1; then
  echo "ERROR: Embedding generation failed" >&2
  echo "$EMBED_RESPONSE" | head -c 200 >&2
  exit 1
fi

EMBEDDING=$(echo "$EMBED_RESPONSE" | jq -c '.data[0].embedding')

# === Query local Qdrant ===
FILTER=$(jq -n --arg id "$CLIENT_ID" '{"must": [{"key": "client_id", "match": {"value": $id}}]}')

if [ -n "$CATEGORY" ]; then
  FILTER=$(echo "$FILTER" | jq --arg cat "$CATEGORY" \
    '.must += [{"key": "category", "match": {"value": $cat}}]')
fi

SEARCH_RESPONSE=$(curl -s --max-time 10 -X POST \
  "${QDRANT_URL}/collections/${QDRANT_COLLECTION}/points/search" \
  -H "api-key: ${QDRANT_API_KEY}" \
  -H "Content-Type: application/json" \
  -d "{
    \"vector\": ${EMBEDDING},
    \"filter\": ${FILTER},
    \"limit\": ${LIMIT},
    \"with_payload\": true,
    \"score_threshold\": 0.3
  }")

LOCAL_RESULTS=$(echo "$SEARCH_RESPONSE" | jq -r '.result[]? |
  "[LOCAL] [score: \(.score | tostring | .[0:5])] [\(.payload.category)] [\(.payload.created_at)] \(.payload.text)"')

# Update last_accessed on returned points
POINT_IDS=$(echo "$SEARCH_RESPONSE" | jq -c '[.result[]?.id]')
if [ "$POINT_IDS" != "[]" ] && [ "$POINT_IDS" != "null" ]; then
  (curl -s --max-time 5 -X POST \
    "${QDRANT_URL}/collections/${QDRANT_COLLECTION}/points/payload" \
    -H "api-key: ${QDRANT_API_KEY}" \
    -H "Content-Type: application/json" \
    -d "{
      \"points\": ${POINT_IDS},
      \"payload\": {
        \"last_accessed\": \"$(date -u +"%Y-%m-%dT%H:%M:%SZ")\"
      }
    }" > /dev/null 2>&1 &)
fi

# === Query Shared Brain ===
BRAIN_RESULTS=""
if [ "$BRAIN_AVAILABLE" = "true" ]; then
  QS="q=$(jq -rn --arg q "$QUERY" '$q | @uri')&limit=${LIMIT}"
  [ "$CLIENT_ID" != "global" ] && QS="${QS}&client_id=${CLIENT_ID}"
  [ -n "$CATEGORY" ] && QS="${QS}&category=${CATEGORY}"

  BRAIN_RESPONSE=$(curl -s --max-time 10 -H "X-Api-Key: ${BRAIN_API_KEY}" \
    "${BRAIN_API_URL}/memory/search?${QS}" 2>/dev/null || echo '{"count":0}')

  BRAIN_COUNT=$(echo "$BRAIN_RESPONSE" | jq -r '.count // 0' 2>/dev/null)

  if [ "$BRAIN_COUNT" != "0" ] && [ "$BRAIN_COUNT" != "null" ]; then
    BRAIN_RESULTS=$(echo "$BRAIN_RESPONSE" | jq -r '.results[] |
      "[SHARED] [score: \(.score | tostring | .[0:5])] [\(.source_agent)] [\(.created_at)] \(.text)"')
  fi
fi

# === Merge and display ===
# Shared Brain results first (higher authority), then local
HAS_BRAIN=false
HAS_LOCAL=false
[ -n "$BRAIN_RESULTS" ] && HAS_BRAIN=true
[ -n "$LOCAL_RESULTS" ] && HAS_LOCAL=true

if [ "$HAS_BRAIN" = "false" ] && [ "$HAS_LOCAL" = "false" ]; then
  echo "No memories found for client_id=${CLIENT_ID} matching: ${QUERY}"
  exit 0
fi

echo "[MEMORY_START]"
echo "Query: ${QUERY}"
echo "Client: ${CLIENT_ID}"

if [ "$HAS_BRAIN" = "true" ] && [ "$HAS_LOCAL" = "true" ]; then
  echo "Sources: Shared Brain + Local Qdrant (Shared Brain takes priority on conflicts)"
elif [ "$HAS_BRAIN" = "true" ]; then
  echo "Source: Shared Brain"
else
  echo "Source: Local Qdrant"
fi

echo "Results:"

# Shared Brain results listed first — they have authority
if [ "$HAS_BRAIN" = "true" ]; then
  echo "$BRAIN_RESULTS"
fi

if [ "$HAS_LOCAL" = "true" ]; then
  echo "$LOCAL_RESULTS"
fi

echo "[MEMORY_END]"

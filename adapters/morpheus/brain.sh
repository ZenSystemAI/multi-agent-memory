#!/usr/bin/env bash
set -euo pipefail

# === Config ===
API_URL="http://192.168.18.40:8084"
SOURCE_AGENT="morpheus"

# Load API key from .env
if [ -f ~/.openclaw/.env ]; then
  export $(grep -E 'BRAIN_API_KEY' ~/.openclaw/.env | xargs)
fi

if [ -z "${BRAIN_API_KEY:-}" ]; then
  echo "ERROR: BRAIN_API_KEY not set in ~/.openclaw/.env" >&2
  exit 2
fi

AUTH_HEADER="X-Api-Key: ${BRAIN_API_KEY}"

# === Subcommand ===
if [ $# -lt 1 ]; then
  echo "Usage: brain.sh {store|search|briefing|query} [options]" >&2
  exit 1
fi

CMD="$1"
shift

# === Parse args ===
TYPE="" CONTENT="" CLIENT_ID="global" CATEGORY="" IMPORTANCE=""
QUERY="" LIMIT="" SINCE="" INCLUDE="" SOURCE="" KEY="" SUBJECT="" STATUS_VALUE=""

while [[ $# -gt 0 ]]; do
  case $1 in
    --type) TYPE="$2"; shift 2 ;;
    --content) CONTENT="$2"; shift 2 ;;
    --client_id) CLIENT_ID="$2"; shift 2 ;;
    --category) CATEGORY="$2"; shift 2 ;;
    --importance) IMPORTANCE="$2"; shift 2 ;;
    --query) QUERY="$2"; shift 2 ;;
    --limit) LIMIT="$2"; shift 2 ;;
    --since) SINCE="$2"; shift 2 ;;
    --include) INCLUDE="$2"; shift 2 ;;
    --source_agent) SOURCE="$2"; shift 2 ;;
    --key) KEY="$2"; shift 2 ;;
    --subject) SUBJECT="$2"; shift 2 ;;
    --status_value) STATUS_VALUE="$2"; shift 2 ;;
    *) echo "Unknown arg: $1" >&2; exit 1 ;;
  esac
done

# === Commands ===

case "$CMD" in

  store)
    if [ -z "$TYPE" ] || [ -z "$CONTENT" ]; then
      echo "ERROR: --type and --content are required for store" >&2
      exit 1
    fi

    # Build JSON payload with jq (handles escaping safely)
    PAYLOAD=$(jq -n \
      --arg type "$TYPE" \
      --arg content "$CONTENT" \
      --arg source_agent "$SOURCE_AGENT" \
      --arg client_id "$CLIENT_ID" \
      --arg category "${CATEGORY:-episodic}" \
      --arg importance "${IMPORTANCE:-medium}" \
      --arg key "$KEY" \
      --arg subject "$SUBJECT" \
      --arg status_value "$STATUS_VALUE" \
      '{
        type: $type,
        content: $content,
        source_agent: $source_agent,
        client_id: $client_id,
        category: $category,
        importance: $importance
      }
      + (if $key != "" then {key: $key} else {} end)
      + (if $subject != "" then {subject: $subject} else {} end)
      + (if $status_value != "" then {status_value: $status_value} else {} end)')

    RESPONSE=$(curl -s --max-time 15 -X POST "${API_URL}/memory" \
      -H "Content-Type: application/json" \
      -H "${AUTH_HEADER}" \
      -d "$PAYLOAD")

    if echo "$RESPONSE" | jq -e '.id' > /dev/null 2>&1; then
      ID=$(echo "$RESPONSE" | jq -r '.id')
      HASH=$(echo "$RESPONSE" | jq -r '.content_hash')
      QDRANT=$(echo "$RESPONSE" | jq -r '.stored_in.qdrant')
      BASEROW=$(echo "$RESPONSE" | jq -r '.stored_in.baserow')
      echo "Stored in Shared Brain (id: ${ID}, hash: ${HASH}, qdrant: ${QDRANT}, baserow: ${BASEROW})"
    else
      echo "ERROR: Store failed" >&2
      echo "$RESPONSE" | head -c 300 >&2
      exit 1
    fi
    ;;

  search)
    if [ -z "$QUERY" ]; then
      echo "ERROR: --query is required for search" >&2
      exit 1
    fi

    # Build query string
    QS="q=$(jq -rn --arg q "$QUERY" '$q | @uri')"
    [ -n "$TYPE" ] && QS="${QS}&type=${TYPE}"
    [ -n "$SOURCE" ] && QS="${QS}&source_agent=${SOURCE}"
    [ -n "$CLIENT_ID" ] && [ "$CLIENT_ID" != "global" ] && QS="${QS}&client_id=${CLIENT_ID}"
    [ -n "$CATEGORY" ] && QS="${QS}&category=${CATEGORY}"
    [ -n "$LIMIT" ] && QS="${QS}&limit=${LIMIT}"

    RESPONSE=$(curl -s --max-time 15 -H "${AUTH_HEADER}" "${API_URL}/memory/search?${QS}")

    COUNT=$(echo "$RESPONSE" | jq -r '.count // 0')
    if [ "$COUNT" = "0" ]; then
      echo "No results found for: ${QUERY}"
      exit 0
    fi

    echo "[SHARED_BRAIN_START]"
    echo "Query: ${QUERY} — ${COUNT} results"
    echo ""
    echo "$RESPONSE" | jq -r '.results[] | "---\n[\(.source_agent)] [\(.type)] [\(.importance)] \(.created_at)\nClient: \(.client_id)\n\(.text)\n"'
    echo "[SHARED_BRAIN_END]"
    ;;

  briefing)
    if [ -z "$SINCE" ]; then
      echo "ERROR: --since is required for briefing" >&2
      exit 1
    fi

    QS="since=$(jq -rn --arg s "$SINCE" '$s | @uri')&agent=${SOURCE_AGENT}"
    [ -n "$INCLUDE" ] && QS="${QS}&include=${INCLUDE}"

    RESPONSE=$(curl -s --max-time 15 -H "${AUTH_HEADER}" "${API_URL}/briefing?${QS}")

    if ! echo "$RESPONSE" | jq -e '.summary' > /dev/null 2>&1; then
      echo "ERROR: Briefing request failed" >&2
      echo "$RESPONSE" | head -c 300 >&2
      exit 1
    fi

    TOTAL=$(echo "$RESPONSE" | jq -r '.summary.total_entries')
    EVENTS=$(echo "$RESPONSE" | jq -r '.summary.events')
    FACTS=$(echo "$RESPONSE" | jq -r '.summary.facts_updated')
    STATUSES=$(echo "$RESPONSE" | jq -r '.summary.status_changes')
    DECISIONS=$(echo "$RESPONSE" | jq -r '.summary.decisions')
    AGENTS=$(echo "$RESPONSE" | jq -r '.summary.agents_active | join(", ")')

    echo "[SHARED_BRAIN_BRIEFING]"
    echo "Since: ${SINCE}"
    echo "Total: ${TOTAL} entries — Events: ${EVENTS}, Facts: ${FACTS}, Status: ${STATUSES}, Decisions: ${DECISIONS}"
    echo "Agents active: ${AGENTS}"
    echo ""

    # Show events
    if [ "$EVENTS" != "0" ]; then
      echo "=== Events ==="
      echo "$RESPONSE" | jq -r '.events[] | "[\(.source_agent)] \(.created_at): \(.content)"'
      echo ""
    fi

    # Show facts
    if [ "$FACTS" != "0" ]; then
      echo "=== Facts Updated ==="
      echo "$RESPONSE" | jq -r '.facts_updated[] | "[\(.source_agent)] \(.client_id): \(.content)"'
      echo ""
    fi

    # Show status changes
    if [ "$STATUSES" != "0" ]; then
      echo "=== Status Changes ==="
      echo "$RESPONSE" | jq -r '.status_changes[] | "[\(.source_agent)] \(.content)"'
      echo ""
    fi

    # Show decisions
    if [ "$DECISIONS" != "0" ]; then
      echo "=== Decisions ==="
      echo "$RESPONSE" | jq -r '.decisions[] | "[\(.source_agent)] \(.content)"'
      echo ""
    fi

    echo "[/SHARED_BRAIN_BRIEFING]"
    ;;

  query)
    QS=""
    [ -n "$TYPE" ] && QS="type=${TYPE}"
    [ -n "$SOURCE" ] && QS="${QS:+${QS}&}source_agent=${SOURCE}"
    [ -n "$CLIENT_ID" ] && [ "$CLIENT_ID" != "global" ] && QS="${QS:+${QS}&}client_id=${CLIENT_ID}"
    [ -n "$CATEGORY" ] && QS="${QS:+${QS}&}category=${CATEGORY}"
    [ -n "$SINCE" ] && QS="${QS:+${QS}&}since=$(jq -rn --arg s "$SINCE" '$s | @uri')"
    [ -n "$KEY" ] && QS="${QS:+${QS}&}key=${KEY}"
    [ -n "$SUBJECT" ] && QS="${QS:+${QS}&}subject=${SUBJECT}"

    RESPONSE=$(curl -s --max-time 15 -H "${AUTH_HEADER}" "${API_URL}/memory/query?${QS}")

    COUNT=$(echo "$RESPONSE" | jq -r '.count // 0')
    RTYPE=$(echo "$RESPONSE" | jq -r '.type // "unknown"')

    echo "[SHARED_BRAIN_QUERY]"
    echo "Type: ${RTYPE} — ${COUNT} results"
    echo ""

    if [ "$COUNT" != "0" ]; then
      echo "$RESPONSE" | jq -r '.results[] | "---\n\(. | to_entries | map("\(.key): \(.value)") | join("\n"))\n"'
    else
      echo "No results."
    fi

    echo "[/SHARED_BRAIN_QUERY]"
    ;;

  *)
    echo "Unknown command: $CMD" >&2
    echo "Usage: brain.sh {store|search|briefing|query} [options]" >&2
    exit 1
    ;;

esac

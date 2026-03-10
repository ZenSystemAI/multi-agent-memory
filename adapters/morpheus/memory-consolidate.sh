#!/bin/bash
# memory-consolidate.sh — Cron: consolidate native session chunks into Qdrant
# Extraction: OpenAI GPT-5.2 with JSON mode (was: Anthropic Haiku, was: Ollama Qwen 14B)
# Embedding: OpenAI text-embedding-3-small via store.sh (was: Ollama nomic-embed-text)
# Bridge: cross-agent facts also pushed to Shared Brain API
set -uo pipefail

# === Configuration ===
SQLITE_DB="$HOME/.openclaw/memory/main.sqlite"
STATE_FILE="$HOME/.openclaw/scripts/.consolidate-last-run"
STORE_SCRIPT="$HOME/.openclaw/skills/memory-store/store.sh"
OPENAI_URL="https://api.openai.com/v1/chat/completions"
OPENAI_MODEL="gpt-5.2"
LOG_FILE="$HOME/.openclaw/memory-audit.log"
BATCH_SIZE=10
MAX_BATCHES=20

if [ -f "$HOME/.openclaw/.env" ]; then
    export $(grep -E 'QDRANT_API_KEY|OPENAI_API_KEY|BRAIN_API_KEY|BRAIN_API_URL' "$HOME/.openclaw/.env" | xargs)
fi

if [ -z "${OPENAI_API_KEY:-}" ]; then
    echo "ERROR: OPENAI_API_KEY not set" >&2
    exit 2
fi

log() {
    echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) CONSOLIDATE $*" >> "$LOG_FILE"
    echo "[consolidate] $*"
}

# === Shared Brain Bridge ===
BRAIN_API_URL="${BRAIN_API_URL:-http://localhost:8084}"
BRAIN_BRIDGE_ENABLED=false
if [ -n "${BRAIN_API_KEY:-}" ] && [ -n "$BRAIN_API_URL" ]; then
    BRAIN_BRIDGE_ENABLED=true
    log "Shared Brain bridge enabled ($BRAIN_API_URL)"
else
    log "WARNING: Shared Brain bridge disabled (BRAIN_API_KEY or BRAIN_API_URL missing)"
fi
BRAIN_STORED=0

# Push a fact to the Shared Brain API
bridge_to_brain() {
    local text="$1" client_id="$2" category="$3" importance="$4"

    if [ "$BRAIN_BRIDGE_ENABLED" != "true" ]; then
        return 0
    fi

    # Map local categories to Shared Brain memory types
    local brain_type="fact"

    local payload
    payload=$(jq -n \
        --arg type "$brain_type" \
        --arg content "$text" \
        --arg source_agent "${BRAIN_AGENT_NAME:-my-agent}" \
        --arg client_id "$client_id" \
        --arg category "$category" \
        --arg importance "$importance" \
        '{
            type: $type,
            content: $content,
            source_agent: $source_agent,
            client_id: $client_id,
            category: $category,
            importance: $importance
        }')

    local response
    response=$(curl -s --max-time 10 -X POST "${BRAIN_API_URL}/memory" \
        -H "Content-Type: application/json" \
        -H "X-Api-Key: ${BRAIN_API_KEY}" \
        -d "$payload" 2>/dev/null)

    if echo "$response" | jq -e '.id' > /dev/null 2>&1; then
        local dedup
        dedup=$(echo "$response" | jq -r '.deduplicated')
        if [ "$dedup" = "true" ]; then
            log "BRIDGE: deduplicated — ${text:0:60}"
        else
            BRAIN_STORED=$((BRAIN_STORED + 1))
            log "BRIDGE: stored — ${text:0:60}"
        fi
    else
        log "BRIDGE WARNING: store failed — ${text:0:60}"
    fi
}

if [ -f "$STATE_FILE" ]; then
    LAST_RUN=$(cat "$STATE_FILE")
else
    LAST_RUN=$(date -d '24 hours ago' +%s)000
    log "first run — processing last 24h"
fi

log "querying chunks since $LAST_RUN"

CHUNKS_JSON=$(sqlite3 -json "$SQLITE_DB" \
    "SELECT id, path, source, text, updated_at
     FROM chunks
     WHERE updated_at > $LAST_RUN
       AND source = 'memory'
     ORDER BY updated_at ASC
     LIMIT $(( BATCH_SIZE * MAX_BATCHES ));" 2>/dev/null || echo "[]")

CHUNKS_JSON="${CHUNKS_JSON:-[]}"
CHUNK_COUNT=$(echo "$CHUNKS_JSON" | jq 'length')

if [ "$CHUNK_COUNT" -eq 0 ]; then
    log "no new chunks — skipping"
    echo "$(date +%s)000" > "$STATE_FILE"
    exit 0
fi

log "found $CHUNK_COUNT new chunks to process"

scrub_credentials() {
    sed -E \
        -e 's/sk-[A-Za-z0-9]{20,}/[REDACTED_KEY]/g' \
        -e 's/ghp_[A-Za-z0-9]{36,}/[REDACTED_GH]/g' \
        -e 's/AKIA[A-Z0-9]{16}/[REDACTED_AWS]/g' \
        -e 's/xoxb-[A-Za-z0-9\-]+/[REDACTED_SLACK]/g' \
        -e 's/xapp-[A-Za-z0-9\-]+/[REDACTED_SLACK]/g' \
        -e 's/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/[REDACTED_EMAIL]/g' \
        -e 's/Bearer [A-Za-z0-9_.+=-]*/Bearer [REDACTED]/g' \
        -e 's/-----BEGIN [A-Z]+ PRIVATE KEY-----/[REDACTED_PRIVKEY]/g'
}

BATCH_NUM=0
FACTS_STORED=0
FACTS_SKIPPED=0

while [ $BATCH_NUM -lt $MAX_BATCHES ]; do
    OFFSET=$(( BATCH_NUM * BATCH_SIZE ))
    BATCH=$(echo "$CHUNKS_JSON" | jq -r ".[$OFFSET:$((OFFSET + BATCH_SIZE))]")
    BATCH_LEN=$(echo "$BATCH" | jq 'length')

    if [ "$BATCH_LEN" -eq 0 ]; then
        break
    fi

    COMBINED_TEXT=$(echo "$BATCH" | jq -r '.[].text' | scrub_credentials | head -c 8000)

    if [ ${#COMBINED_TEXT} -lt 100 ]; then
        BATCH_NUM=$((BATCH_NUM + 1))
        continue
    fi

    PROMPT="You are a fact extractor for long-term agent memory.

EXTRACT ONLY:
- Business decisions (strategy, technical choices, budget)
- Confirmed client preferences (tone, style, restrictions, contacts)
- Established procedures (workflows, configs, how to do X)
- Permanent technical facts (IPs, versions, architecture, configs)
- Actionable insights and original findings

IGNORE:
- API quotas, usage counters, temporary metrics
- System instructions, prompts, session/cron metadata
- Technical logs, error messages, sub-agent status
- Full content of articles (only key insights)
- Obvious or generic facts
- Greetings, unanswered questions, debug discussions

RULES for client_id:
- Internal/organizational → \"global\"
- A named client → exact client name
- If no specific client → \"global\"

QUALITY:
- Each fact must be self-contained (understandable alone)
- Maximum 1-2 sentences per fact
- Prefer 3 quality facts over 10 noisy ones

Classify: semantic (permanent), episodic (dated), procedural (how-to)
Importance: critical (loss=business impact), high (often useful), medium (context), low (nice to know)

cross_agent: true if the fact concerns MULTIPLE agents or systems (network architecture, infrastructure decisions, shared client preferences, cross-machine configs). false if purely local to this agent (internal session, local debug, agent-specific config).

STRICT JSON — nothing else:
{\"facts\": [
  {\"text\": \"concise fact\", \"client_id\": \"global\", \"category\": \"semantic\", \"importance\": \"high\", \"cross_agent\": true}
]}

If no important facts: {\"facts\": []}

CONVERSATION:
$COMBINED_TEXT"

    # Build OpenAI API payload
    PROMPT_FILE=$(mktemp)
    echo "$PROMPT" > "$PROMPT_FILE"
    PAYLOAD_FILE=$(mktemp)
    jq -n --arg model "$OPENAI_MODEL" --rawfile prompt "$PROMPT_FILE" \
        '{model: $model, max_tokens: 2000, temperature: 0.1, response_format: {type: "json_object"}, messages: [{role: "system", content: "You extract facts and return valid JSON objects. Always respond with a JSON object containing a facts array."}, {role: "user", content: $prompt}]}' > "$PAYLOAD_FILE"

    RESPONSE=$(curl -s --max-time 120 "$OPENAI_URL" \
        -H "Content-Type: application/json" \
        -H "Authorization: Bearer ${OPENAI_API_KEY}" \
        -d @"$PAYLOAD_FILE" \
        2>/dev/null)

    rm -f "$PROMPT_FILE"

    # Retry once on failure
    if [ -z "$RESPONSE" ]; then
        log "WARNING: OpenAI timeout on batch $BATCH_NUM — retrying"
        sleep 5
        RESPONSE=$(curl -s --max-time 120 "$OPENAI_URL" \
            -H "Content-Type: application/json" \
            -H "Authorization: Bearer ${OPENAI_API_KEY}" \
            -d @"$PAYLOAD_FILE" 2>/dev/null)
    fi

    rm -f "$PAYLOAD_FILE"

    # Extract text from OpenAI response
    RAW_FACTS=$(echo "$RESPONSE" | jq -r '.choices[0].message.content // empty' 2>/dev/null)

    if [ -z "$RAW_FACTS" ]; then
        ERROR_MSG=$(echo "$RESPONSE" | jq -r '.error.message // empty' 2>/dev/null)
        if [ -n "$ERROR_MSG" ]; then
            log "ERROR: OpenAI API error on batch $BATCH_NUM: $ERROR_MSG"
        else
            log "WARNING: empty OpenAI response on batch $BATCH_NUM"
        fi
        BATCH_NUM=$((BATCH_NUM + 1))
        continue
    fi

    # With JSON mode, response is guaranteed valid JSON — extract .facts array
    FACTS_JSON=$(echo "$RAW_FACTS" | jq -c '.facts // []')

    if ! echo "$FACTS_JSON" | jq empty 2>/dev/null; then
        log "WARNING: invalid JSON from OpenAI on batch $BATCH_NUM — skipping"
        BATCH_NUM=$((BATCH_NUM + 1))
        continue
    fi

    FACT_COUNT=$(echo "$FACTS_JSON" | jq 'length')

    if [ "$FACT_COUNT" -eq 0 ]; then
        BATCH_NUM=$((BATCH_NUM + 1))
        continue
    fi

    for i in $(seq 0 $((FACT_COUNT - 1))); do
        FACT_TEXT=$(echo "$FACTS_JSON" | jq -r ".[$i].text // empty")
        FACT_CLIENT=$(echo "$FACTS_JSON" | jq -r ".[$i].client_id // \"global\"")
        FACT_CATEGORY=$(echo "$FACTS_JSON" | jq -r ".[$i].category // \"semantic\"")
        FACT_IMPORTANCE=$(echo "$FACTS_JSON" | jq -r ".[$i].importance // \"medium\"")
        FACT_CROSS_AGENT=$(echo "$FACTS_JSON" | jq -r ".[$i].cross_agent // false")

        if [ -z "$FACT_TEXT" ] || [ ${#FACT_TEXT} -lt 10 ]; then
            FACTS_SKIPPED=$((FACTS_SKIPPED + 1))
            continue
        fi

        case "$FACT_CATEGORY" in
            semantic|episodic|procedural) ;;
            *) FACT_CATEGORY="semantic" ;;
        esac

        case "$FACT_IMPORTANCE" in
            critical|high|medium|low) ;;
            *) FACT_IMPORTANCE="medium" ;;
        esac

        STORE_RESULT=$(bash "$STORE_SCRIPT" \
            --text "$FACT_TEXT" \
            --client_id "$FACT_CLIENT" \
            --category "$FACT_CATEGORY" \
            --importance "$FACT_IMPORTANCE" 2>&1)

        if echo "$STORE_RESULT" | grep -q "Memory stored"; then
            FACTS_STORED=$((FACTS_STORED + 1))

            # Bridge to Shared Brain if cross-agent relevant
            if [ "$FACT_CROSS_AGENT" = "true" ]; then
                bridge_to_brain "$FACT_TEXT" "$FACT_CLIENT" "$FACT_CATEGORY" "$FACT_IMPORTANCE"
            fi
        else
            log "WARNING: store failed for fact: ${FACT_TEXT:0:80}"
            FACTS_SKIPPED=$((FACTS_SKIPPED + 1))
        fi
    done

    log "batch $BATCH_NUM: extracted $FACT_COUNT facts"
    BATCH_NUM=$((BATCH_NUM + 1))
done

echo "$(date +%s)000" > "$STATE_FILE"
log "DONE: $FACTS_STORED stored locally, $BRAIN_STORED bridged to Shared Brain, $FACTS_SKIPPED skipped from $CHUNK_COUNT chunks"
unset QDRANT_API_KEY OPENAI_API_KEY BRAIN_API_KEY

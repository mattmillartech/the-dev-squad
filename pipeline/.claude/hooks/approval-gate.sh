#!/bin/bash
#
# Pipeline Approval Gate (Hardened)
#
# Per-agent permission enforcement. Auto mode handles general safety.
# This hook handles pipeline-specific rules with DENY-BY-DEFAULT.
#
# AGENT S (Supervisor): Read unrestricted. Write/Edit jailed to ~/Builds/. Bash allowed.
# AGENT A (Planner):    Can only write plan.md. No Bash. No Agent tool. No writes during Phase 0.
# AGENT B (Reviewer):   Cannot write anything. No Bash. No Agent tool.
# AGENT C (Coder):      Can write anything inside ~/Builds/ except plan.md and .claude/. No Agent tool.
# AGENT D (Tester):     Cannot write anything. No Agent tool.
#
# ALL: Write/Edit outside ~/Builds/ blocked. .claude/ paths blocked for all agents.
# DEFAULT: DENY (any unrecognized tool is blocked, not allowed)
#

INPUT=$(cat)
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name')
TOOL_INPUT=$(echo "$INPUT" | jq -c '.tool_input')
CWD=$(echo "$INPUT" | jq -r '.cwd')

BUILDS_DIR="$HOME/Builds"
AGENT="${PIPELINE_AGENT:-unknown}"

# ── V9 fix: Reject empty/malformed tool name ────────────────────────

if [ -z "$TOOL_NAME" ] || [ "$TOOL_NAME" = "null" ]; then
  echo "BLOCKED: Could not parse tool name" >&2
  exit 2
fi

# ── V7 fix: Reject unknown agent identity ────────────────────────────

if [[ ! "$AGENT" =~ ^[ABCDS]$ ]]; then
  echo "BLOCKED: Unknown agent identity '$AGENT'" >&2
  exit 2
fi

# ── Auto-approve read-only tools (all agents) ────────────────────────

case "$TOOL_NAME" in
  Read|Glob|Grep|ToolSearch|TaskCreate|TaskUpdate|TaskGet|TaskList|TaskOutput|WebSearch|LSP)
    echo '{"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "allow"}}'
    exit 0
    ;;
esac

# ── Block Agent tool for ALL agents ──────────────────────────────────

if [ "$TOOL_NAME" = "Agent" ]; then
  echo "BLOCKED: Agent $AGENT cannot spawn sub-agents" >&2
  exit 2
fi

# ── V8 fix: Block WebFetch (data exfiltration risk) ──────────────────

if [ "$TOOL_NAME" = "WebFetch" ]; then
  echo "BLOCKED: Agent $AGENT cannot use WebFetch" >&2
  exit 2
fi

# ── Helper: resolve and validate file path ───────────────────────────

resolve_filepath() {
  local fp="$1"
  # Make absolute
  if [[ "$fp" != /* ]]; then
    fp="$CWD/$fp"
  fi
  # V10 fix: Reject .. in paths
  if [[ "$fp" == *".."* ]]; then
    echo "BLOCKED"
    return
  fi
  # Resolve directory symlinks
  fp=$(cd "$(dirname "$fp")" 2>/dev/null && echo "$(pwd -P)/$(basename "$fp")" || echo "BLOCKED")
  # V4 fix: Resolve file-level symlinks
  if command -v readlink >/dev/null 2>&1; then
    local resolved
    resolved=$(readlink -f "$fp" 2>/dev/null)
    if [ -n "$resolved" ]; then
      fp="$resolved"
    fi
  fi
  echo "$fp"
}

# ── Per-agent Write/Edit/NotebookEdit rules ──────────────────────────
# V5 fix: NotebookEdit is now gated like Write/Edit

case "$TOOL_NAME" in
  Write|Edit|NotebookEdit)
    FILEPATH=$(echo "$TOOL_INPUT" | jq -r '.file_path // ""')
    FILEPATH=$(resolve_filepath "$FILEPATH")

    if [ "$FILEPATH" = "BLOCKED" ]; then
      echo "BLOCKED: Invalid file path" >&2
      exit 2
    fi

    FILENAME=$(basename "$FILEPATH")

    # V6 fix: Trailing slash in prefix check
    if [[ "$FILEPATH" != "$BUILDS_DIR/"* ]]; then
      echo "BLOCKED: Cannot write to $FILEPATH — outside ~/Builds/" >&2
      exit 2
    fi

    # V1/V2 fix: Block writes to .claude/ for ALL agents (including S)
    if [[ "$FILEPATH" == *"/.claude/"* ]] || [[ "$FILEPATH" == *"/.claude" ]]; then
      echo "BLOCKED: Cannot modify hook/settings files" >&2
      exit 2
    fi

    # Phase 0 check for A
    if [ "$AGENT" = "A" ]; then
      EVENTS_FILE=""
      CHECK="$CWD"
      while [ "$CHECK" != "/" ]; do
        if [ -f "$CHECK/pipeline-events.json" ]; then
          EVENTS_FILE="$CHECK/pipeline-events.json"
          break
        fi
        CHECK=$(dirname "$CHECK")
      done
      if [ -n "$EVENTS_FILE" ]; then
        CURRENT_PHASE=$(jq -r '.currentPhase // "concept"' "$EVENTS_FILE" 2>/dev/null)
        if [ "$CURRENT_PHASE" = "concept" ]; then
          echo "BLOCKED: Agent A cannot write during Phase 0" >&2
          exit 2
        fi
      fi
    fi

    # Agent-specific write rules
    case "$AGENT" in
      S)
        # S can write inside ~/Builds/ (already verified above) but not .claude/
        ;;
      A)
        if [[ "$FILENAME" != "plan.md" ]]; then
          echo "BLOCKED: Agent A can only write plan.md, not $FILENAME" >&2
          exit 2
        fi
        ;;
      B)
        echo "BLOCKED: Agent B cannot write files" >&2
        exit 2
        ;;
      C)
        if [[ "$FILENAME" == "plan.md" ]]; then
          echo "BLOCKED: Agent C cannot modify plan.md — it is locked" >&2
          exit 2
        fi
        ;;
      D)
        echo "BLOCKED: Agent D cannot write files" >&2
        exit 2
        ;;
    esac

    echo '{"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "allow"}}'
    exit 0
    ;;
esac

# ── Per-agent Bash rules ─────────────────────────────────────────────

if [ "$TOOL_NAME" = "Bash" ]; then
  case "$AGENT" in
    A)
      echo "BLOCKED: Agent A cannot run commands" >&2
      exit 2
      ;;
    B)
      echo "BLOCKED: Agent B cannot run commands" >&2
      exit 2
      ;;
  esac

  # V3 fix: Block bash commands that try to spawn claude or change agent identity
  COMMAND=$(echo "$TOOL_INPUT" | jq -r '.command // ""')
  if echo "$COMMAND" | grep -qiE 'PIPELINE_AGENT|claude\s+-p|claude\s+--'; then
    echo "BLOCKED: Cannot spawn Claude sessions or modify agent identity via Bash" >&2
    exit 2
  fi

  # V1 fix (Bash path): Block bash commands targeting .claude/ directory
  if echo "$COMMAND" | grep -qE '\.claude/|\.claude\\b|settings\.json|approval-gate'; then
    echo "BLOCKED: Cannot modify hook or settings files via Bash" >&2
    exit 2
  fi

  # C, D, S: auto mode handles bash safety
  echo '{"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "allow"}}'
  exit 0
fi

# ── DENY BY DEFAULT ──────────────────────────────────────────────────
# Any tool not explicitly handled above is BLOCKED.
# This catches NotebookEdit (if somehow missed), WebFetch, and any future tools.

echo "BLOCKED: Tool '$TOOL_NAME' is not allowed for Agent $AGENT" >&2
exit 2

/**
 * POST /api/review — Headless code review endpoint with web UI visibility.
 *
 * Spawns `claude -p` with a configurable working directory, system prompt,
 * and permission mode. Designed for automated review gates where the caller
 * needs Claude to read files, run git commands, and return structured JSON
 * from within a mounted repository.
 *
 * Events are written to the manual state file so the Dev Squad web UI
 * shows real-time review activity (tool calls, text output, usage).
 *
 * Request body:
 *   {
 *     systemPrompt: string,       // Review-specific system prompt
 *     message: string,            // The review instructions (can reference files in cwd)
 *     agent?: string,             // Agent label for UI display (default: 'B')
 *     model?: string,             // Default: process.env.DEV_SQUAD_MODEL || 'claude-sonnet-4-6'
 *     cwd?: string,               // Working directory for claude (default: ~/Builds)
 *     addDirs?: string[],         // Additional directories to allow access to
 *     permissionMode?: string,    // Default: 'auto'
 *     allowedTools?: string[],    // Explicit tool allowlist (e.g. ["Bash(git:*)", "Read", "Glob"])
 *     effort?: string,            // Reasoning effort level
 *   }
 *
 * Response: { success: boolean, result?: string, error?: string, usage?: object }
 */

import { spawn as nodeSpawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { homedir } from 'node:os';
import { join, basename } from 'node:path';
import { NextRequest, NextResponse } from 'next/server';

const BUILDS_DIR = join(homedir(), 'Builds');
const MANUAL_DIR = join(BUILDS_DIR, '.manual');
const MANUAL_STATE_FILE = join(MANUAL_DIR, 'manual-state.json');

// Appended to every review system prompt to enforce thorough, boundary-aware analysis.
const REVIEW_METHODOLOGY = `

## Review Process (mandatory — follow in order)

1. Fetch the latest code and generate the full diff.
2. For EVERY changed file in the diff:
   a. Read the complete file (not just the diff hunks) to understand surrounding context.
   b. Trace each changed function/method: read its callers and callees to verify integration.
   c. Apply the boundary-thinking questions below to each change.
   d. If the file has corresponding tests (e.g. foo.ts → foo.test.ts), read them and verify coverage.
3. Review any test results provided — verify all tests pass.
4. Produce your verdict.

## How to Think About Each Change

For every change in the diff, ask these questions — not just about the happy path, but at the boundaries:

- **Data volume:** What happens when this operates on MORE data than the author assumed? If a function caps a query but then reports success unconditionally, it is buggy — the function's correctness cannot depend on an assumption about data volume unless the code actually enforces that assumption (validates, paginates, or explicitly fails). "It's unlikely to exceed N" is not a defense; unlikely failures in production are silent corruption. If there is no enforcement, flag it.
- **Partial failure:** What state does this leave behind if it fails halfway? Partial writes, dangling references, held resources, transactions that should be atomic but aren't.
- **Authorization:** Who can reach this code path, and are they authorized? Trace from the entry point (route, callable, rule, trigger).
- **Test isolation:** If this change touches test files, verify that every piece of global state modified in setup is restored in teardown. Be specific: check for assignments to global.*, window.*, or module-level objects. Framework helpers like jest.restoreAllMocks() only undo jest.spyOn() calls — direct property assignments survive and leak into other tests in the same worker. If you see a direct global assignment without a corresponding manual restore, flag it.
- **Contract mismatches:** Does the caller's contract match the callee's guarantees? Type assertions, unchecked casts, and optional-chained reads that discard failure all hide mismatches.
- **Security:** Shell injection in exec/spawn, XSS vectors, sensitive data in logs/responses, missing input validation at system boundaries.

IMPORTANT: If you find ANY issue through this analysis — even one you think is "theoretical" or "unlikely" — it MUST appear in the findings array. Do not bury concerns in reasoning text while returning a clean verdict. A finding that the code doesn't defend against is a finding, period. The humans will decide what to fix and what to accept.

## Response Format

Your ENTIRE response must be a single JSON object. No prose, no markdown fences — raw JSON only.

If ALL checks pass with no concerns:
{"status":"passed","filesReviewed":["file1.ts","file2.ts"],"summary":"<2-3 sentences: what you verified, which tests you checked, why you're confident>"}

or (for design/correctness reviews):
{"status":"approved","filesReviewed":["file1.ts","file2.ts"],"reasoning":"<2-3 sentences explaining what you checked and why no blockers>"}

If ANY issue found:
{"status":"failed","findings":[{"file":"path/to/file.ts","line":42,"severity":"error|warning","category":"correctness|security|data-integrity|test-isolation|performance","description":"Specific issue with code reference"}],"filesReviewed":["file1.ts"],"summary":"<overview>"}

or (for design/correctness reviews):
{"status":"issues","findings":[{"file":"path","line":0,"severity":"error|warning","category":"category","description":"issue"}],"filesReviewed":["file1.ts"],"summary":"<overview>"}

Use severity "error" for correctness/security bugs. Use severity "warning" for issues that are not immediately exploitable but represent missing defensive code. Any response with findings MUST use a non-passing status.

A response with no filesReviewed or an empty filesReviewed array is INVALID. You must prove you read the code.
A passed/approved verdict with no summary/reasoning is INVALID. You must justify your verdict.`;

function readManualState(): Record<string, unknown> {
  if (existsSync(MANUAL_STATE_FILE)) {
    try { return JSON.parse(readFileSync(MANUAL_STATE_FILE, 'utf8')); } catch {}
  }
  mkdirSync(MANUAL_DIR, { recursive: true });
  const fresh: Record<string, unknown> = {
    concept: '',
    projectDir: MANUAL_DIR,
    currentPhase: 'review',
    securityMode: 'fast',
    activeAgent: '',
    agentStatus: { A: 'idle', B: 'idle', C: 'idle', D: 'idle', S: 'idle' },
    sessions: {},
    buildComplete: false,
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalCostUsd: 0 },
    runtime: { activeTurn: null },
    events: [],
  };
  writeFileSync(MANUAL_STATE_FILE, JSON.stringify(fresh, null, 2));
  return fresh;
}

function appendEvent(agent: string, type: string, text: string) {
  try {
    const state = readManualState();
    const events = (state.events as Array<Record<string, unknown>>) || [];
    events.push({ time: new Date().toISOString(), agent, phase: 'review', type, text });
    state.events = events;
    writeFileSync(MANUAL_STATE_FILE, JSON.stringify(state, null, 2));
  } catch {}
}

function updateAgentStatus(agent: string, status: string) {
  try {
    const state = readManualState();
    const agentStatus = (state.agentStatus as Record<string, string>) || {};
    agentStatus[agent] = status;
    state.agentStatus = agentStatus;
    state.activeAgent = status === 'active' ? agent : '';
    writeFileSync(MANUAL_STATE_FILE, JSON.stringify(state, null, 2));
  } catch {}
}

function updateUsage(agent: string, event: Record<string, unknown>) {
  try {
    const state = readManualState();
    if (!state.sessions) state.sessions = {};
    const sessions = state.sessions as Record<string, string>;
    sessions[agent] = (event.session_id as string) || sessions[agent] || '';
    const usage = event.usage as Record<string, number>;
    if (usage && state.usage) {
      const u = state.usage as Record<string, number>;
      u.inputTokens = (u.inputTokens || 0) + (usage.input_tokens || 0);
      u.outputTokens = (u.outputTokens || 0) + (usage.output_tokens || 0);
      u.cacheReadTokens = (u.cacheReadTokens || 0) + (usage.cache_read_input_tokens || 0);
      u.cacheWriteTokens = (u.cacheWriteTokens || 0) + (usage.cache_creation_input_tokens || 0);
    }
    const cost = event.total_cost_usd as number;
    if (cost && state.usage) {
      (state.usage as Record<string, number>).totalCostUsd =
        ((state.usage as Record<string, number>).totalCostUsd || 0) + cost;
    }
    writeFileSync(MANUAL_STATE_FILE, JSON.stringify(state, null, 2));
  } catch {}
}

export async function POST(req: NextRequest) {
  const {
    systemPrompt,
    message,
    agent = 'B',
    model = process.env.DEV_SQUAD_MODEL || 'claude-sonnet-4-6',
    cwd = BUILDS_DIR,
    addDirs = [],
    permissionMode = 'auto',
    allowedTools = [],
    effort,
  } = await req.json();

  if (!systemPrompt || !message) {
    return NextResponse.json(
      { success: false, error: 'systemPrompt and message are required' },
      { status: 400 },
    );
  }

  // Append the standard review methodology to the caller's system prompt
  const fullSystemPrompt = systemPrompt + REVIEW_METHODOLOGY;

  // Build claude CLI args — prompt goes via stdin, not -p, to avoid MAX_ARG_STRLEN
  const args: string[] = [
    '-p',                             // print mode (non-interactive)
    '--system-prompt', fullSystemPrompt,
    '--model', model,
    '--output-format', 'stream-json',
    '--verbose',
  ];

  if (permissionMode) {
    args.push('--permission-mode', permissionMode);
  }

  if (effort) {
    args.push('--effort', effort);
  }

  for (const dir of addDirs) {
    args.push('--add-dir', dir);
  }

  if (allowedTools.length > 0) {
    args.push('--allowedTools', ...allowedTools);
  }

  // Write initial events to manual state for web UI visibility
  updateAgentStatus(agent, 'active');
  appendEvent(agent, 'user_msg', `Review request: ${message.slice(0, 200)}${message.length > 200 ? '...' : ''}`);

  return new Promise<NextResponse>((resolve) => {
    const child = nodeSpawn('claude', args, {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    // Pipe the message via stdin (avoids 128KB single-arg limit)
    child.stdin.write(message);
    child.stdin.end();

    const rl = createInterface({ input: child.stdout });
    let resultText = '';
    let usage: Record<string, unknown> = {};
    let totalCost = 0;
    let isError = false;
    let stderr = '';

    rl.on('line', (line) => {
      if (!line.trim()) return;
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(line);
      } catch {
        return;
      }

      const type = event.type as string;

      // Stream events to manual state for web UI
      if (type === 'assistant') {
        const msg = event.message as Record<string, unknown>;
        const content = msg?.content as Array<Record<string, unknown>>;
        if (content) {
          for (const block of content) {
            if (block.type === 'tool_use') {
              const toolName = block.name as string;
              const input = block.input as Record<string, unknown>;
              let desc = toolName;
              if (toolName === 'Read' && input.file_path) desc = `Reading: ${basename(input.file_path as string)}`;
              else if (toolName === 'Bash' && input.command) desc = `Running: ${(input.command as string).slice(0, 80)}`;
              else if (toolName === 'Glob' && input.pattern) desc = `Glob: ${input.pattern}`;
              else if (toolName === 'Grep' && input.pattern) desc = `Grep: ${input.pattern}`;
              appendEvent(agent, 'tool_call', desc);
            } else if (block.type === 'text') {
              const text = ((block.text as string) || '').trim();
              if (text) appendEvent(agent, 'text', text);
            }
          }
        }
      } else if (type === 'result') {
        resultText = typeof event.result === 'string' ? event.result : '';
        isError = !!event.is_error;
        usage = (event.usage as Record<string, unknown>) || {};
        totalCost = (event.total_cost_usd as number) || 0;
        updateUsage(agent, event);
      }
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', (err) => {
      updateAgentStatus(agent, 'idle');
      appendEvent(agent, 'failure', `Spawn error: ${err.message}`);
      resolve(
        NextResponse.json(
          { success: false, error: `Spawn error: ${err.message}` },
          { status: 500 },
        ),
      );
    });

    child.on('close', () => {
      updateAgentStatus(agent, 'idle');

      if (isError || !resultText) {
        resolve(
          NextResponse.json({
            success: false,
            error: resultText || stderr.slice(0, 500) || 'No output from claude',
            usage,
            totalCostUsd: totalCost,
          }),
        );
      } else {
        // Validate response quality — reject shallow verdicts with no evidence of review
        let parsed: Record<string, unknown> | null = null;
        try { parsed = JSON.parse(resultText.trim()); } catch {
          // Brace-matching extraction for nested JSON (handles findings arrays, etc.)
          const text = resultText;
          for (let i = 0; i < text.length; i++) {
            if (text[i] !== '{') continue;
            let depth = 0;
            let inStr = false;
            let esc = false;
            for (let j = i; j < text.length; j++) {
              const ch = text[j];
              if (esc) { esc = false; continue; }
              if (ch === '\\' && inStr) { esc = true; continue; }
              if (ch === '"') { inStr = !inStr; continue; }
              if (inStr) continue;
              if (ch === '{' || ch === '[') depth++;
              else if (ch === '}' || ch === ']') depth--;
              if (depth === 0) {
                try {
                  const candidate = JSON.parse(text.slice(i, j + 1));
                  if (candidate && typeof candidate.status === 'string') { parsed = candidate; }
                } catch { /* try next opening brace */ }
                break;
              }
            }
            if (parsed) break;
          }
        }

        if (parsed && typeof parsed.status === 'string') {
          const filesReviewed = parsed.filesReviewed as string[] | undefined;
          if (!filesReviewed || filesReviewed.length === 0) {
            appendEvent(agent, 'failure', 'REJECTED: verdict had no filesReviewed — agent did not prove it read the code');
            resolve(NextResponse.json({
              success: false,
              error: 'Agent returned a verdict with no filesReviewed. The review was not thorough enough.',
              usage, totalCostUsd: totalCost,
            }));
            return;
          }
          const isPassingVerdict = parsed.status === 'passed' || parsed.status === 'approved';
          if (isPassingVerdict && !parsed.summary && !parsed.reasoning) {
            appendEvent(agent, 'failure', `REJECTED: ${parsed.status} verdict had no summary/reasoning`);
            resolve(NextResponse.json({
              success: false,
              error: `Agent returned {"status":"${parsed.status}"} with no summary or reasoning. Cannot accept an unjustified verdict.`,
              usage, totalCostUsd: totalCost,
            }));
            return;
          }
        }

        resolve(
          NextResponse.json({
            success: true,
            result: resultText,
            usage,
            totalCostUsd: totalCost,
          }),
        );
      }
    });
  });
}

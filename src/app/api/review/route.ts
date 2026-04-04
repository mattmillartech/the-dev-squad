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

  // Build claude CLI args — prompt goes via stdin, not -p, to avoid MAX_ARG_STRLEN
  const args: string[] = [
    '-p',                             // print mode (non-interactive)
    '--system-prompt', systemPrompt,
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

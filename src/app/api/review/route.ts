/**
 * POST /api/review — Headless code review endpoint.
 *
 * Spawns `claude -p` with a configurable working directory, system prompt,
 * and permission mode. Designed for automated review gates where the caller
 * needs Claude to read files, run git commands, and return structured JSON
 * from within a mounted repository.
 *
 * Unlike /api/chat (manual mode), this endpoint:
 * - Does NOT use the pipeline or manual state machinery
 * - Does NOT restrict the agent to ~/Builds/.manual
 * - Does NOT persist sessions or events
 * - Supports `--dangerously-skip-permissions` for non-interactive use
 * - Supports `--add-dir` for multi-directory access
 * - Pipes the prompt via stdin to avoid MAX_ARG_STRLEN (128KB) limits
 *
 * Request body:
 *   {
 *     systemPrompt: string,       // Review-specific system prompt
 *     message: string,            // The review instructions (can reference files in cwd)
 *     model?: string,             // Default: process.env.DEV_SQUAD_MODEL || 'claude-sonnet-4-6'
 *     cwd?: string,               // Working directory for claude (default: ~/Builds)
 *     addDirs?: string[],         // Additional directories to allow access to
 *     permissionMode?: string,    // Default: 'auto'
 *     effort?: string,            // Reasoning effort level
 *   }
 *
 * Response: { success: boolean, result?: string, error?: string, usage?: object }
 */

import { spawn as nodeSpawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { NextRequest, NextResponse } from 'next/server';

const BUILDS_DIR = join(homedir(), 'Builds');

export async function POST(req: NextRequest) {
  const {
    systemPrompt,
    message,
    model = process.env.DEV_SQUAD_MODEL || 'claude-sonnet-4-6',
    cwd = BUILDS_DIR,
    addDirs = [],
    permissionMode = 'auto',
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

  // Use --permission-mode for all modes. 'bypassPermissions' is the safe equivalent
  // of --dangerously-skip-permissions that works when running as root.
  if (permissionMode) {
    args.push('--permission-mode', permissionMode);
  }

  if (effort) {
    args.push('--effort', effort);
  }

  for (const dir of addDirs) {
    args.push('--add-dir', dir);
  }

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

      if (event.type === 'result') {
        resultText = typeof event.result === 'string' ? event.result : '';
        isError = !!event.is_error;
        usage = (event.usage as Record<string, unknown>) || {};
        totalCost = (event.total_cost_usd as number) || 0;
      }
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', (err) => {
      resolve(
        NextResponse.json(
          { success: false, error: `Spawn error: ${err.message}` },
          { status: 500 },
        ),
      );
    });

    child.on('close', () => {
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

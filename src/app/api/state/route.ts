import { readFileSync, readdirSync, statSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { NextRequest, NextResponse } from 'next/server';
import { EMPTY_RUNTIME } from '@/lib/pipeline-runtime';

const BUILDS_DIR = join(homedir(), 'Builds');
const STAGING_DIR = join(BUILDS_DIR, '.staging');
const MANUAL_DIR = join(BUILDS_DIR, '.manual');

const EMPTY_STATE = {
  concept: '', projectDir: '', currentPhase: 'concept', securityMode: 'fast', runGoal: 'full-build', stopAfterPhase: 'none', pipelineStatus: 'idle', activeAgent: '',
  agentStatus: { A: 'idle', B: 'idle', C: 'idle', D: 'idle', S: 'idle' },
  sessions: {}, buildComplete: false,
  usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalCostUsd: 0 },
  runtime: { ...EMPTY_RUNTIME },
  events: [],
};

function normalizeState(data: Record<string, unknown>) {
  return {
    ...EMPTY_STATE,
    ...data,
    securityMode: data.securityMode === 'strict' ? 'strict' : 'fast',
    runGoal: data.runGoal === 'plan-only' ? 'plan-only' : 'full-build',
    stopAfterPhase: data.stopAfterPhase === 'plan-review' ? 'plan-review' : 'none',
    resumeAction: data.resumeAction === 'continue-approved-plan' || data.resumeAction === 'resume-stalled-turn'
      ? data.resumeAction
      : 'none',
    pipelineStatus: typeof data.pipelineStatus === 'string'
      ? data.pipelineStatus
      : (data.buildComplete ? 'complete' : (data.currentPhase && data.currentPhase !== 'concept' ? 'running' : 'idle')),
    agentStatus: { ...EMPTY_STATE.agentStatus, ...(data.agentStatus as Record<string, string> | undefined) },
    usage: { ...EMPTY_STATE.usage, ...(data.usage as Record<string, number> | undefined) },
    runtime: data.runtime && typeof data.runtime === 'object' ? data.runtime : { ...EMPTY_RUNTIME },
    events: Array.isArray(data.events) ? data.events : [],
  };
}

function findLatestProject(): string | null {
  try {
    const dirs = readdirSync(BUILDS_DIR)
      .filter(name => name !== '.staging' && name !== '.manual')
      .map(name => join(BUILDS_DIR, name))
      .filter(p => {
        try { return statSync(p).isDirectory() && statSync(join(p, 'pipeline-events.json')).isFile(); }
        catch { return false; }
      })
      .sort((a, b) => statSync(join(b, 'pipeline-events.json')).mtimeMs - statSync(join(a, 'pipeline-events.json')).mtimeMs);
    return dirs[0] || null;
  } catch { return null; }
}

export async function GET(req: NextRequest) {
  const mode = req.nextUrl.searchParams.get('mode') || 'pipeline';

  // Manual mode — read from .manual directory
  if (mode === 'manual') {
    const manualEvents = join(MANUAL_DIR, 'manual-state.json');
    if (existsSync(manualEvents)) {
      try {
        const data = JSON.parse(readFileSync(manualEvents, 'utf8'));
        return NextResponse.json(normalizeState(data));
      } catch {}
    }
    return NextResponse.json(EMPTY_STATE);
  }

  // Pipeline mode — check staging first, then real projects
  const stagingEvents = join(STAGING_DIR, 'pipeline-events.json');
  if (existsSync(stagingEvents)) {
    try {
      const data = JSON.parse(readFileSync(stagingEvents, 'utf8'));
      return NextResponse.json(normalizeState(data));
    } catch {}
  }

  const projectDir = findLatestProject();
  if (!projectDir) {
    return NextResponse.json(EMPTY_STATE);
  }

  try {
    const raw = JSON.parse(readFileSync(join(projectDir, 'pipeline-events.json'), 'utf8'));
    const data = normalizeState(raw);
    const pipelineStatus = data.pipelineStatus;
    const isVisible =
      pipelineStatus === 'running' ||
      pipelineStatus === 'paused' ||
      pipelineStatus === 'failed' ||
      pipelineStatus === 'complete' ||
      !!data.buildComplete;
    if (isVisible) {
      return NextResponse.json(data);
    }
    return NextResponse.json(EMPTY_STATE);
  } catch {
    return NextResponse.json(EMPTY_STATE);
  }
}

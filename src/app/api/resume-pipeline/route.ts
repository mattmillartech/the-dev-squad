import { spawn } from 'child_process';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { NextRequest, NextResponse } from 'next/server';

const BUILDS_DIR = join(homedir(), 'Builds');
const BUILDUI_DIR = join(process.cwd(), 'pipeline');

function findLatestProject(): string | null {
  try {
    const dirs = readdirSync(BUILDS_DIR)
      .filter((name) => name !== '.staging' && name !== '.manual')
      .map((name) => join(BUILDS_DIR, name))
      .filter((projectDir) => {
        try {
          return statSync(projectDir).isDirectory() && statSync(join(projectDir, 'pipeline-events.json')).isFile();
        } catch {
          return false;
        }
      })
      .sort(
        (a, b) =>
          statSync(join(b, 'pipeline-events.json')).mtimeMs - statSync(join(a, 'pipeline-events.json')).mtimeMs
      );

    return dirs[0] || null;
  } catch {
    return null;
  }
}

export async function POST(req: NextRequest) {
  let requestedProjectDir = '';
  try {
    const body = await req.json();
    requestedProjectDir = typeof body?.projectDir === 'string' ? body.projectDir : '';
  } catch {}

  const projectDir = requestedProjectDir || findLatestProject();
  if (!projectDir) {
    return NextResponse.json({ success: false, error: 'No pipeline project found' });
  }

  const eventsFile = join(projectDir, 'pipeline-events.json');
  if (!existsSync(eventsFile)) {
    return NextResponse.json({ success: false, error: 'No pipeline state found' });
  }

  let state: Record<string, unknown>;
  try {
    state = JSON.parse(readFileSync(eventsFile, 'utf8'));
  } catch {
    return NextResponse.json({ success: false, error: 'Could not read pipeline state' });
  }

  const currentPhase = String(state.currentPhase || 'concept');
  const pipelineStatus = String(state.pipelineStatus || (state.buildComplete ? 'complete' : 'idle'));
  const activeTurn = (state.runtime as { activeTurn?: { status?: string; agent?: string; phase?: string } } | undefined)?.activeTurn;
  const isStalled = activeTurn?.status === 'stalled';
  const canResumeSupportedTurn = isStalled && (
    (activeTurn?.agent === 'A' && (activeTurn?.phase === 'planning' || activeTurn?.phase === 'plan-review')) ||
    (activeTurn?.agent === 'B' && activeTurn?.phase === 'plan-review')
  );
  const canContinueApprovedPlan = pipelineStatus === 'paused' && currentPhase === 'plan-review';

  if (!canResumeSupportedTurn && !canContinueApprovedPlan) {
    return NextResponse.json({
      success: false,
      error: 'This pipeline is not paused after review and does not have a resumable stalled turn',
    });
  }

  if (canContinueApprovedPlan) {
    state.runGoal = 'full-build';
    state.stopAfterPhase = 'none';
    state.resumeAction = 'continue-approved-plan';
  } else {
    state.resumeAction = 'resume-stalled-turn';
  }

  if (Array.isArray(state.events)) {
    state.events.push({
      time: new Date().toISOString(),
      agent: 'S',
      phase: currentPhase,
      type: 'status',
      text: canContinueApprovedPlan
        ? 'Supervisor resumed the build from the approved plan'
        : 'Supervisor requested a manual resume of the stalled turn',
    });
  }

  writeFileSync(eventsFile, JSON.stringify(state, null, 2));

  const orchestratorPath = join(BUILDUI_DIR, 'orchestrator.ts');
  const child = spawn('npx', ['tsx', orchestratorPath, '--project-dir', projectDir], {
    cwd: projectDir,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
    env: { ...process.env, PIPELINE_SECURITY_MODE: String(state.securityMode || 'fast') },
  });

  child.stdout?.on('data', (data) => process.stdout.write(data));
  child.stderr?.on('data', (data) => process.stderr.write(data));
  child.unref();

  return NextResponse.json({ success: true, projectDir });
}

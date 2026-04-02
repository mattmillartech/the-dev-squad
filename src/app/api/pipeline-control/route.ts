import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { NextRequest, NextResponse } from 'next/server';

const BUILDS_DIR = join(homedir(), 'Builds');

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
  let action = '';
  try {
    const body = await req.json();
    action = typeof body?.action === 'string' ? body.action : '';
  } catch {}

  const projectDir = findLatestProject();
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

  if (action === 'stop-after-review') {
    state.stopAfterPhase = 'plan-review';
  } else if (action === 'clear-stop-after-review') {
    state.stopAfterPhase = 'none';
  } else {
    return NextResponse.json({ success: false, error: 'Unsupported pipeline control action' });
  }

  if (Array.isArray(state.events)) {
    state.events.push({
      time: new Date().toISOString(),
      agent: 'S',
      phase: state.currentPhase || 'concept',
      type: 'status',
      text: action === 'stop-after-review'
        ? 'Supervisor armed stop-after-review'
        : 'Supervisor cleared stop-after-review',
    });
  }

  writeFileSync(eventsFile, JSON.stringify(state, null, 2));

  return NextResponse.json({
    success: true,
    stopAfterPhase: state.stopAfterPhase,
  });
}

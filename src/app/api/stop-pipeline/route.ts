import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { execSync } from 'child_process';
import { NextResponse } from 'next/server';

const BUILDS_DIR = join(homedir(), 'Builds');

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
  } catch {
    return null;
  }
}

export async function POST() {
  try {
    // Kill orchestrator and any claude sessions it spawned
    // Use specific patterns that won't match the dev server
    execSync('pkill -f "tsx.*orchestrator\\.ts" 2>/dev/null || true', { encoding: 'utf8' });
    execSync('pkill -f "claude.*--output-format.*stream-json" 2>/dev/null || true', { encoding: 'utf8' });
  } catch {}

  try {
    const projectDir = findLatestProject();
    if (projectDir) {
      const eventsFile = join(projectDir, 'pipeline-events.json');
      if (existsSync(eventsFile)) {
        const state = JSON.parse(readFileSync(eventsFile, 'utf8'));
        state.activeAgent = '';
        state.pipelineStatus = 'paused';
        if (state.agentStatus && typeof state.agentStatus === 'object') {
          for (const [agent, status] of Object.entries(state.agentStatus)) {
            if (status === 'active' || status === 'working') {
              state.agentStatus[agent] = 'idle';
            }
          }
        }
        if (state.runtime && typeof state.runtime === 'object') {
          state.runtime.activeTurn = null;
        }
        if (Array.isArray(state.events)) {
          state.events.push({
            time: new Date().toISOString(),
            agent: 'system',
            phase: state.currentPhase || 'concept',
            type: 'status',
            text: 'Pipeline stopped by user',
          });
        }
        writeFileSync(eventsFile, JSON.stringify(state, null, 2));
      }
    }
  } catch {}

  return NextResponse.json({ success: true });
}

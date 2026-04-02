import assert from 'node:assert/strict';

import { buildSupervisorSnapshot } from '../src/lib/pipeline-supervisor.ts';

const pausedSnapshot = buildSupervisorSnapshot(
  {
    concept: 'Tiny hello page',
    currentPhase: 'plan-review',
    pipelineStatus: 'paused',
    securityMode: 'fast',
    runGoal: 'plan-only',
    stopAfterPhase: 'plan-review',
    activeAgent: '',
    buildComplete: false,
    agentStatus: { A: 'idle', B: 'done', C: 'idle', D: 'idle', S: 'idle' },
    runtime: { activeTurn: null },
    events: [{ time: '2026-04-02T00:00:00.000Z', agent: 'B', phase: 'plan-review', type: 'approval', text: 'PLAN APPROVED' }],
  },
  null
);

assert.match(pausedSnapshot, /Run goal: plan-only/);
assert.match(pausedSnapshot, /Pipeline status: paused/);
assert.match(pausedSnapshot, /Recommend CONTINUE BUILD/i);

const stalledSnapshot = buildSupervisorSnapshot(
  {
    concept: 'Tiny hello page',
    currentPhase: 'planning',
    pipelineStatus: 'running',
    securityMode: 'fast',
    runGoal: 'full-build',
    stopAfterPhase: 'none',
    activeAgent: 'A',
    buildComplete: false,
    agentStatus: { A: 'active', B: 'idle', C: 'idle', D: 'idle', S: 'idle' },
    runtime: {
      activeTurn: {
        agent: 'A',
        phase: 'planning',
        status: 'stalled',
        lastEventAt: '2026-04-02T00:00:00.000Z',
        promptSummary: 'Write plan.md',
        autoResumeCount: 1,
      },
    },
    events: [{ time: '2026-04-02T00:00:00.000Z', agent: 'system', phase: 'planning', type: 'status', text: 'Agent A appears stalled.' }],
  },
  null
);

assert.match(stalledSnapshot, /Active turn: A \/ planning \/ stalled/);
assert.match(stalledSnapshot, /RESUME STALLED RUN/);

console.log('supervisor snapshot checks passed');

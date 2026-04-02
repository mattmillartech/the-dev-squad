import type { PendingApproval } from '@/lib/pipeline-approval';

interface PipelineEventLike {
  time: string;
  agent: string;
  phase: string;
  type: string;
  text: string;
}

interface RuntimeLike {
  activeTurn?: {
    agent?: string;
    phase?: string;
    status?: string;
    lastEventAt?: string;
    promptSummary?: string;
    autoResumeCount?: number;
  } | null;
}

interface PipelineStateLike {
  concept?: string;
  currentPhase?: string;
  securityMode?: string;
  runGoal?: string;
  stopAfterPhase?: string;
  pipelineStatus?: string;
  activeAgent?: string;
  buildComplete?: boolean;
  agentStatus?: Record<string, string>;
  runtime?: RuntimeLike;
  events?: PipelineEventLike[];
}

function formatAgentStatuses(agentStatus: Record<string, string> | undefined): string {
  if (!agentStatus) return 'A=idle, B=idle, C=idle, D=idle, S=idle';
  return ['A', 'B', 'C', 'D', 'S']
    .map((agent) => `${agent}=${agentStatus[agent] || 'idle'}`)
    .join(', ');
}

function formatRecentEvents(events: PipelineEventLike[] | undefined, limit: number = 8): string {
  if (!events || events.length === 0) return '- No events yet';
  return events
    .slice(-limit)
    .map((event) => `- [${event.agent} | ${event.phase} | ${event.type}] ${event.text}`)
    .join('\n');
}

export function buildSupervisorSnapshot(
  state: PipelineStateLike,
  pendingApproval: PendingApproval | null
): string {
  const activeTurn = state.runtime?.activeTurn;
  const recommendedActions: string[] = [];

  if (pendingApproval?.approved === null) {
    recommendedActions.push(`A pending approval exists for ${pendingApproval.agent} ${pendingApproval.tool}: ${pendingApproval.description}`);
  }

  if (
    state.pipelineStatus === 'paused' &&
    state.currentPhase === 'plan-review' &&
    state.buildComplete !== true
  ) {
    recommendedActions.push('The plan is approved and the run is paused. Recommend CONTINUE BUILD if the user wants coding to start.');
  }

  if (
    activeTurn?.status === 'stalled' &&
    (activeTurn.agent === 'A' || activeTurn.agent === 'B') &&
    (activeTurn.phase === 'planning' || activeTurn.phase === 'plan-review')
  ) {
    recommendedActions.push('A recoverable stalled planning/review turn exists. Recommend RESUME STALLED RUN.');
  }

  if (
    state.pipelineStatus === 'running' &&
    state.runGoal === 'full-build' &&
    (state.currentPhase === 'planning' || state.currentPhase === 'plan-review')
  ) {
    recommendedActions.push('If the user wants to stop before coding, STOP AFTER REVIEW is available right now.');
  }

  return [
    '[LIVE TEAM SNAPSHOT]',
    `Concept: ${state.concept || '(not set yet)'}`,
    `Phase: ${state.currentPhase || 'concept'}`,
    `Pipeline status: ${state.pipelineStatus || 'idle'}`,
    `Security mode: ${state.securityMode || 'fast'}`,
    `Run goal: ${state.runGoal || 'full-build'}`,
    `Stop after phase: ${state.stopAfterPhase || 'none'}`,
    `Active agent: ${state.activeAgent || 'none'}`,
    `Build complete: ${state.buildComplete ? 'yes' : 'no'}`,
    `Agent statuses: ${formatAgentStatuses(state.agentStatus)}`,
    activeTurn
      ? `Active turn: ${activeTurn.agent || '?'} / ${activeTurn.phase || '?'} / ${activeTurn.status || 'running'} / idle prompt "${activeTurn.promptSummary || ''}" / auto-resumes ${activeTurn.autoResumeCount || 0}`
      : 'Active turn: none',
    pendingApproval?.approved === null
      ? `Pending approval: ${pendingApproval.agent} ${pendingApproval.tool} — ${pendingApproval.description}`
      : 'Pending approval: none',
    'Recent events:',
    formatRecentEvents(state.events),
    'Recommended supervisor actions:',
    recommendedActions.length > 0
      ? recommendedActions.map((action) => `- ${action}`).join('\n')
      : '- No special control action recommended right now.',
    '[END SNAPSHOT]',
  ].join('\n');
}

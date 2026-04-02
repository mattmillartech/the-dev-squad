import assert from 'node:assert/strict';

import {
  buildPlanningSelfReviewResumePrompt,
  buildPlanningWriteResumePrompt,
  detectPlanningStep,
} from '../src/lib/pipeline-planning.ts';

assert.equal(detectPlanningStep([], { planExists: false }), 'research');

assert.equal(
  detectPlanningStep(
    [{ agent: 'A', phase: 'planning', type: 'text', text: 'Research is complete. Writing plan.md now.' }],
    { planExists: false }
  ),
  'write'
);

assert.equal(detectPlanningStep([], { planExists: true }), 'self-review');

assert.equal(
  detectPlanningStep(
    [{ agent: 'A', phase: 'planning', type: 'status', text: 'Plan self-review complete' }],
    { planExists: true }
  ),
  'done'
);

assert.match(buildPlanningWriteResumePrompt('/tmp/demo'), /Use the Write tool/i);
assert.match(buildPlanningSelfReviewResumePrompt('/tmp/demo'), /stalled during the self-review step/i);

console.log('pipeline-planning checks passed');

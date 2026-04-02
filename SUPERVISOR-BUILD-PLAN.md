# Supervisor And Dev Team Build Plan

This document captures the next product direction for The Dev Squad so the idea survives context loss and implementation stays coherent.

## Product Thesis

The Dev Squad should feel like this:

- you give Claude a dev team
- `S` is the manager/operator
- `A`, `B`, `C`, and `D` are the specialists
- the whole team follows the same master doctrine:
  - `build-plan-template.md`
  - `checklist.md`
  - the current project context

This is not mainly an autonomy story.

It is a quality-and-coordination story:

- one supervisor
- four specialists
- one shared operating system for how work gets done

## What Changes From The Old Pipeline Model

The old framing was:

- rigid pipeline lanes
- hard handoffs
- hooks as the main product story
- user often acting like the orchestrator

The new framing should be:

- `S` manages the team
- the specialists know the team structure
- all workers know the shared doctrine
- hooks become lighter role guardrails, not the product identity
- the user talks to the supervisor, not to a workflow engine

## Shared Doctrine

The master doctrine for the team is:

1. `build-plan-template.md`
2. `checklist.md`
3. the locked `plan.md` once approved

That doctrine should be visible to the whole team:

- `A` uses it to research and write
- `B` uses it to review
- `C` uses it to implement
- `D` uses it to review and test
- `S` uses it to manage and diagnose

The checklist and template are not just planner-only artifacts anymore. They are the team's operating system.

## Supervisor Model

`S` should act like the manager of the dev team.

That means:

- `S` knows each specialist's role
- `S` understands where the build is in the process
- `S` can explain what the team is doing
- `S` can recommend whether to continue, stop, retry, or recover
- `S` eventually becomes the main control surface for plan-only, stop-after-review, resume, and similar actions

`S` should not become "the same worker with more Bash." The real control authority should still live in deterministic host/orchestrator code.

## Worker Model

### `A` — Planner

- researches
- writes `plan.md`
- performs one self-review pass
- answers review questions from `B`

### `B` — Plan Reviewer

- audits the plan against the same doctrine
- looks for gaps, unverified claims, and architectural weakness
- does not rubber-stamp

### `C` — Coder

- treats the approved plan as the implementation contract
- asks for clarification instead of improvising
- loops with `D` until the implementation is accepted

### `D` — Reviewer + Tester

- checks implementation against the plan
- tests behavior against the plan
- sends concrete issues back to `C`

## Hook Philosophy

Hooks should remain, but with a smaller and clearer purpose.

Keep hooks for:

- cross-project safety
- plan-lock safety
- recursive-agent safety
- strict-mode Bash approvals
- obvious role-boundary violations that damage team discipline

Do not treat hooks as the product itself.

The team should feel coordinated because of:

- shared doctrine
- supervisor management
- specialist roles

not because every behavior is over-policed by shell rules.

## Immediate Problem To Solve

The most expensive current failure mode is not "an agent disobeyed its lane."

It is:

- long valuable turns stall
- the user loses confidence
- resets waste tokens
- the system feels like a workflow engine instead of a team

That is why recoverability and supervisor-led control remain the first engineering priority.

## Phase Plan

## Phase 1: Team Doctrine Rewrite

Goal: make the current product feel like a supervised dev team instead of a rigid pipeline.

### Deliverables

- rewrite `role-s.md` as the manager/operator of the team
- rewrite `role-a.md`, `role-b.md`, `role-c.md`, and `role-d.md` so each agent:
  - knows the team structure
  - knows the shared doctrine
  - understands when to escalate vs follow the process
- update `build-plan-template.md` and `checklist-template.md` so they read like team doctrine, not just A-only instructions
- update README and architecture docs to describe the product as "Claude with a dev team"
- reduce hook language in docs from "pipeline law" to "role guardrails"

### Acceptance Criteria

- the repo reads like a supervisor-led team product
- all specialists reference the shared doctrine
- `S` is clearly the operator/recovery role
- docs no longer over-center the rigid pipeline framing

## Phase 2: Supervisor Controls

Goal: let `S` actually manage the team instead of only diagnosing it.

### Deliverables

- plan-only control
- stop-after-review control
- resume stalled run control
- clearer run summaries for `S`
- user-facing controls that map to supervisor actions

### Acceptance Criteria

- the user can mostly talk to `S`
- `S` can manage the build without the user manually reasoning about the pipeline

## Phase 3: Recovery + Smaller Work Units

Goal: make the team resilient when Claude stalls or upstream quality degrades.

### Deliverables

- keep mid-turn session persistence
- keep stalled-turn visibility
- add resume flows
- optionally split planning into smaller recoverable units

### Acceptance Criteria

- valuable work is recoverable
- reset is no longer the only practical response to stalls

## Phase 4: Sandboxed Team Execution

Goal: strengthen containment without changing the dev-team product model.

### Deliverables

- runner abstraction
- per-project sandbox/container execution
- hooks and policy outside writable project space where possible
- narrower ambient filesystem and network exposure

### Acceptance Criteria

- the team model stays intact
- the security story improves without reverting to "the hooks are the product"

## Current Implementation Recommendation

Implement Phase 1 now.

That means:

1. rewrite the roles around the dev-team model
2. rewrite the template/checklist around shared doctrine
3. refresh the docs around "Claude with a dev team"
4. keep the current recovery work and strict mode
5. defer deeper control-plane and sandbox work to later phases

## Non-Goals

This phase is not about:

- removing all hooks immediately
- removing strict mode
- claiming stronger security than the system actually has
- making `S` the only control point

## Guiding Rule

If we have to choose between:

- a more rigid pipeline
- and a clearer supervisor-led team

prefer the supervisor-led team, as long as we keep enough guardrails to preserve discipline and safety.

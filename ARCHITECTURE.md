# Architecture

One supervisor. Four specialists. Two modes. In **Pipeline Mode**, the team passes work back and forth until it's right. In **Manual Mode**, you are the orchestrator — 5 Claude sessions with expertise labels, no automation, you direct everything.

## The Agents

- **S — Supervisor**: The operator/recovery partner. Reads broadly, explains what the team is doing, and helps the user decide when to wait, stop, retry, or recover.
- **A — Planner**: Chats with the user, researches, writes the build plan, and confirms completion at the end
- **B — Plan Reviewer**: Pokes holes in the plan until there are none left
- **C — Coder**: Follows the approved plan and writes the code
- **D — Code Reviewer + Tester**: Reviews the code against the plan, then tests it

## Product Direction

The product is moving toward "give Claude a dev team":

- `S` is the human-facing supervisor
- `A`, `B`, `C`, and `D` are the worker specialists
- the whole team follows the same doctrine: `build-plan-template.md`, `checklist.md`, and the locked `plan.md`

Today, pipeline mode still starts with **A** in Phase 0 and `S` is primarily a recovery/diagnostic surface. The first supervisor controls are now live: saved-session recovery for A/B planning-review turns, `plan-only`, `stop after review`, and `continue build` from an approved plan. The next implementation step is to make `S` the primary operator while keeping control authority in deterministic host/orchestrator code. The concrete build plan for that transition lives in [SUPERVISOR-BUILD-PLAN.md](SUPERVISOR-BUILD-PLAN.md).

When the user chats with `S` in pipeline mode, the chat route now injects a live team snapshot: current phase, pipeline status, run goal, active turn, recent events, pending approvals, and recommended control actions. That makes `S` much closer to a real team manager instead of a generic diagnostic assistant.

## The Flow

### Phase 0: Concept

1. The **user** chats with **A** in the viewer. This is the only required human interaction.
2. **A** asks clarifying questions — what do you want, how should it work, any constraints?
3. Chat happens in a staging area (`~/Builds/.staging/`). No project directory created yet.
4. When the user hits **START**, staging moves to a real project dir and the pipeline runs autonomously by default. In strict mode, the UI can still surface Bash approvals later in the run.

### Phase 1: Planning

5. **A** reads `build-plan-template.md` — A's playbook.
6. **A** completes the planning checklist — research, write, verify, context, one self-review pass.
7. **A** writes the plan to `plan.md` with complete, copy-pasteable code for every file.
8. **A** self-reviews once, then hands the plan to **B**. **B** is the formal external review gate.

### Phase 1b: Plan Review

9. **B** reads the plan and sends structured questions back to **A**.
10. **A** answers with verified information and updates the plan.
11. This loops until **B** is fully satisfied. No round limit.
12. **B** approves. The plan is locked — no agent can modify it from this point.
13. If the supervisor selected **Plan Only** or armed **Stop After Review**, the pipeline pauses here and waits for an explicit continue command.

### Phase 2: Coding

14. **C** reads the locked plan and builds exactly what it says.
15. No improvising, no interpreting, no "improving."

### Phase 3: Code Review

16. **D** reads the plan and the code. Checks: does the code match the plan?
17. If **D** has issues, sends them to **C**. **C** fixes, sends back.
18. Loops until **D** is satisfied with the code.

### Phase 4: Testing

19. **D** runs the code. Tests it.
20. If tests fail, **D** sends failures to **C**. **C** fixes, **D** tests again.
21. Loops until all tests pass.

### Phase 5: Deploy

22. Build complete. Project is in `~/Builds/<project-name>/`.

## Enforcement: Scripts, Not Prompts

LLMs ignore prompt instructions. An agent told "only write plan.md" will write code files. An agent told "don't modify anything" will edit the plan.

Restrictions are enforced by a `PreToolUse` hook (`pipeline/.claude/hooks/approval-gate.sh`) that prevents agents from accidentally exceeding their role. The hook is a guardrail, not a sandbox — see [SECURITY.md](SECURITY.md) for the threat model, known limitations, and a matrix of what is fixable in-hook vs what requires design changes or OS-level isolation. The hook reads the `PIPELINE_AGENT` environment variable and gates every tool call:

| Agent | Write | Bash | Agent Tool |
|-------|-------|------|------------|
| **A** (Planner) | `plan.md` only in the current project | Blocked | Blocked |
| **B** (Reviewer) | Blocked | Blocked | Blocked |
| **C** (Coder) | Current project only (except plan.md) | Safe=auto, dangerous=approval | Blocked |
| **D** (Tester) | Blocked | Safe=auto, dangerous=approval | Blocked |
| **S** (Supervisor) | `~/Builds/` only (no `.claude/`) | Yes (restricted) | Blocked |

Additional protections:
- `Write`/`Edit`/`NotebookEdit` are jailed to the active project for A/C and blocked for B/D
- Pipeline sessions set `CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR=1`, so Bash `cd` does not persist into later file-edit tool calls
- Plan is locked after B approves
- Agent tool blocked for all agents (prevents recursive spawning)
- Strict mode requires approval for every Bash call from C and D
- `--permission-mode auto` adds Claude's AI safety classifier on top

Roadmap:
- **Fast mode** is the current autonomous default
- **Strict mode** is available for pipeline runs
- **Isolated mode** will run agents inside per-project sandboxes
- **Request-scoped approvals** are now implemented for strict-mode Bash approvals
- The concrete implementation plan lives in [SECURITY-ROADMAP.md](SECURITY-ROADMAP.md)

## Agent Communication

Agents don't parse free text. They communicate via structured JSON schemas:

```json
// B reviewing A's plan
{ "status": "approved" }
{ "status": "questions", "questions": ["What about error handling?"] }

// D reviewing C's code
{ "status": "approved" }
{ "status": "issues", "issues": ["Missing input validation on POST /users"] }

// D testing C's code
{ "status": "passed" }
{ "status": "failed", "failures": ["PUT /users returns 500 on empty body"] }
```

The orchestrator routes these signals and uses `isPositiveSignal()` to normalize approval variants.

## Session Spawning

Each agent runs as a separate Claude Code session:

```bash
claude -p "<prompt>" \
  --system-prompt-file <role-file> \
  --permission-mode auto \
  --model claude-opus-4-6 \
  --output-format stream-json \
  --verbose
```

- `--permission-mode auto` — Claude's AI classifier handles general safety
- `--output-format stream-json` — real-time streaming for the viewer
- `PIPELINE_AGENT` env var — tells the hook which agent is running
- Role files and shared doctrine provide the team model; hooks provide the lighter safety/discipline guardrails around it
- Session ids are now persisted mid-turn so stalled A/B runs can be recovered instead of always forcing a reset
- Future hardening replaces direct host spawning with a sandbox runner; see [SECURITY-ROADMAP.md](SECURITY-ROADMAP.md)

## The Orchestrator

`pipeline/orchestrator.ts` is deterministic code, not an LLM. It:

1. Spawns agent sessions in order
2. Parses their streaming JSON output
3. Routes structured signals between agents
4. Advances the pipeline phase on approval signals
5. Tracks token usage, costs, and events
6. Persists active-turn runtime state and recoverable session ids
7. Can pause cleanly after approved plan review when the supervisor requests it
8. Can continue from an approved plan or manually resume a stalled A/B planning-review turn
9. Writes everything to `pipeline-events.json` for the viewer

The orchestrator cannot be confused, distracted, or convinced to skip steps.

## The Viewer

A Next.js app that polls `pipeline-events.json` every 400ms and renders:

- Pixel art office scene with 5 agents at desks
- Live feed of all events
- 5-panel grid (S + A/B/C/D) with per-agent event streams
- Current-turn and stalled-turn visibility for recovery
- Supervisor controls for `plan-only`, `stop after review`, `continue build`, and `resume stalled run`
- Dashboard with phase progress, token usage, cost
- Per-panel chat inputs for direct agent communication
- START/STOP/Reset controls

API routes handle:
- `POST /api/chat` — spawns a claude session for direct chat (Phase 0 or post-build)
- `POST /api/start-pipeline` — creates project dir from staging, spawns orchestrator
- `POST /api/pipeline-control` — arms or clears supervisor stop-after-review
- `POST /api/resume-pipeline` — continues from an approved plan or resumes a stalled planning/review turn
- `POST /api/stop-pipeline` — kills orchestrator + claude sessions
- `POST /api/reset` — clears staging, resets stuck projects
- `GET /api/state` — returns current pipeline state
- `POST /api/approve` — approves/denies dangerous bash commands

## Data Flow

```
User types in viewer
  -> POST /api/chat -> spawns claude session -> writes to .staging/pipeline-events.json
  -> GET /api/state polls .staging/ -> viewer renders events

User hits START
  -> POST /api/start-pipeline
  -> staging moves to ~/Builds/<project>/
  -> orchestrator spawns as detached process
  -> orchestrator writes to ~/Builds/<project>/pipeline-events.json
  -> GET /api/state polls project dir -> viewer renders events

User hits STOP
  -> POST /api/stop-pipeline -> pkill orchestrator + claude sessions

User hits RESET
  -> POST /api/reset -> clears staging, resets active projects
```

## Communication Map

```
     ┌─────┐
     │ YOU │  gives concept, answers A's questions (Phase 0 only)
     └──┬──┘
        │
        ┌─────┐
        │  B  │  plan reviewer — only talks to A
        └──┬──┘
           │
     ┌─────┴─────┐
     │     A     │  planner / final handoff — talks to everyone
     └─────┬─────┘
           │
     ┌─────┴─────┐
     │     C     │  coder — talks to A (questions) and D (code)
     └─────┬─────┘
           │
     ┌─────┴─────┐
     │     D     │  reviewer + tester — talks to C (fixes) and A (final)
     └───────────┘

     S sits above — supervisor / recovery partner for the team

     After Phase 0, pipeline runs autonomous by default
     Strict mode can still surface approval prompts for C/D Bash
     All sessions: claude --permission-mode auto --model claude-opus-4-6
```

## Manual Mode

In manual mode, the orchestrator does not exist. The user is the orchestrator.

- **No pipeline, no phases, no automation.** 5 Claude sessions with one-line expertise labels.
- **State lives in `~/Builds/.manual/manual-state.json`** — separate from pipeline state.
- **No role files.** Agents get a one-line system prompt on first message:
  - A: "You specialize in software planning and architecture."
  - B: "You specialize in code review and finding gaps."
  - C: "You specialize in writing code."
  - D: "You specialize in testing and debugging."
  - S: "You help oversee and diagnose issues."
- **No `PIPELINE_AGENT` env var** — hooks don't apply pipeline restrictions.
- **Model picker** — user chooses Opus or Sonnet per session.
- **Handoff button** — grabs an agent's last text response and stages it as context for the next agent messaged. Max 2000 chars.
- **Per-agent sending** — multiple agents can be active simultaneously.
- **Session resume** — sessions persist in `manual-state.json` and resume via `--resume`.

```
Manual Mode Data Flow

User types in any panel
  -> POST /api/chat { mode: 'manual', model, agent, message }
  -> spawns claude with --system-prompt (first msg) or --resume (subsequent)
  -> cwd: ~/Builds/.manual/
  -> streams events into manual-state.json
  -> GET /api/state?mode=manual polls manual-state.json -> viewer renders

User hits RESET
  -> POST /api/reset { mode: 'manual' } -> deletes ~/Builds/.manual/
```

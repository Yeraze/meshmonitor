---
name: epic
description: Orchestrate a long-running, multi-phase development effort — Opus architect per phase, Sonnet implementers, review loops, browser validation, docs, PR/CI/merge per phase. For work spanning days, not hours.
---

# Epic — Multi-Phase Development Harness

Orchestrate extensive, multi-phase development work end-to-end. **You (the session running this skill) are the Orchestrator** — you must be running on Fable or Opus. If you are on a smaller model, tell the user to restart the session on Fable/Opus before proceeding; do not orchestrate from Sonnet or Haiku.

## Requested work

$ARGUMENTS

If the argument references an issue number or plan document, read it fully before anything else.

## When to use / not use

- **Use** for work with multiple deliverable phases and extensive development time: large refactors, remediation plans, multi-part features. Each phase ships as its own merged PR.
- **Do not use** for single-PR tasks — use the normal workflow (/worktree → implement → /create-pr → /ci-monitor → /merge).

## Roles and models

| Role | Who | Model |
|------|-----|-------|
| Orchestrator | This session — intake, interview, dispatch, review, quality gate, docs, ship, merge | Fable/Opus (session model) |
| Phase Architect | One `Agent` per phase, converts the phase goal into a concrete implementation spec | `model: opus` |
| Implementers | One `Agent` per work package, execute the spec | `model: sonnet` |
| Specialists | `docker-dev-deployer`, `meshmonitor-docs-writer`, `meshtastic-expert` as needed | per agent definition |

The Orchestrator **never implements feature code itself** — it plans, dispatches, reviews, and gates. Small mechanical fixes during review (a one-line correction, a doc typo) are fine to do directly.

---

## Stage 0 — Intake, interview, and phase plan

1. **Understand the request.** Read the referenced issue/plan/doc, `CLAUDE.md`, and the relevant `docs/internal/dev-notes/` files. Use Explore agents to survey affected code — do not guess at the current state.
2. **Draft the phase breakdown.** Each phase must be independently mergeable (its PR leaves main green and shippable), have explicit exit criteria, and list its dependencies on prior phases.
3. **Interview the user.** Use `AskUserQuestion` (batched, ≤4 per round) for every genuine unknown: scope boundaries, priorities, acceptance criteria, UI expectations, backend/DB choices the request leaves open, what is explicitly out of scope. Iterate until you have no open questions. Do NOT skip this because the request "seems clear" — surface at least your phase breakdown and get explicit confirmation before dispatching any work.
4. **Write the epic plan** to `docs/internal/dev-notes/<EPIC_NAME>_EPIC.md`: goal, interview answers/decisions, phase list with exit criteria, and a status checkbox per phase. This file is the durable state — it must survive context compaction and session restarts. It gets committed in the Phase 1 branch and updated in every subsequent phase branch.
5. **Create tasks** via `TaskCreate` — one per phase — and keep them updated (`in_progress`/`completed`) as you go.

**Resuming:** if invoked and a matching `*_EPIC.md` already exists with unchecked phases, resume from the first incomplete phase instead of re-interviewing. Confirm the resume point with the user in one sentence.

---

## Per-phase loop

Repeat Stages 1–8 for each phase, strictly in order. One phase in flight at a time.

### Stage 1 — Worktree setup

- Branch **from `origin/main`** (fetch first), never from the current checkout's HEAD:
  ```bash
  git fetch origin main
  git worktree add ../meshmonitor-<phase-slug> -b feature/<phase-slug> origin/main
  ```
- In the worktree: `npm install`, `git submodule update --init` (protobuf tests fail without it), copy `.env` and `docker-compose.dev.local.yml` from the main checkout (both are gitignored; the latter is required for device access if deploying).
- Verify with `npm run typecheck` before dispatching agents.

### Stage 2 — Architecture (Opus)

Spawn one Phase Architect: `Agent` with `model: opus`, high effort, `run_in_background: false`. Its prompt must include the phase goal + exit criteria from the epic plan, the worktree path, and instructions to read `CLAUDE.md` and relevant dev-notes. Its deliverable is a written **implementation spec** containing:

- **Reuse inventory (mandatory, first section):** existing services, repositories, hooks, components, and utilities that MUST be used or extended. Reuse over duplication is a hard requirement — the architect must actively search for existing mechanisms (serena symbolic tools) before specifying anything new, and justify any new subsystem against the closest existing one.
- Concrete file-by-file changes: files to create/modify, classes/methods/signatures, API routes (envelope, `requirePermission` scoping), DB changes (follow the migration recipe; all three backends), frontend components/hooks/contexts.
- **Test plan:** which `*.test.ts(x)` files to add/extend, in the standard Vitest suite — never standalone scripts. Per-source features need a `*.perSource.test.ts`.
- Decomposition into **work packages**: each sized for one Sonnet agent, with explicit dependency ordering (which can run in parallel, which must be sequential) and per-package acceptance criteria.

**Gate:** Review the spec yourself against `CLAUDE.md` invariants (per-source scoping, no raw SQL outside repositories, async patterns, `VALID_SETTINGS_KEYS`, migration recipe, key-repair channel routing, etc.) and against the reuse requirement. Send the architect corrections via `SendMessage` until the spec passes. Do not dispatch implementers on a spec you have not approved.

### Stage 3 — Implementation (Sonnet)

Dispatch one `Agent` (`model: sonnet`) per work package — parallel for independent packages, sequential where the spec says so. Every implementer prompt must include:

- The worktree path (all work happens there), its work package verbatim from the spec, and the reuse inventory.
- Standing rules: read `CLAUDE.md` first; follow existing patterns in neighboring code; **reuse the inventoried mechanisms — do not write a parallel implementation of anything that exists**; tests go into the standard suite and must pass locally (targeted run) before finishing.
- **Commit discipline: commit early and often** with descriptive conventional-commit messages — after each coherent unit of work, not one giant commit at the end. **Never push.** Never touch `main`.
- Report back: files changed, commits made, test results, anything from the spec they could not complete and why.

### Stage 4 — Review loop (Orchestrator)

When implementers finish, review before anything else runs:

1. **Read the full diff** (`git diff origin/main...HEAD` in the worktree). Judge quality, architecture, and conformance to the spec, the reuse inventory, and `CLAUDE.md`. Watch specifically for: duplicated logic that should have reused an existing mechanism, missing `sourceId` scoping, raw SQL outside repositories, missing/hand-rolled tests, `any` creep, sync/async signature mistakes after edits.
2. **Verify mechanically:** `npm run typecheck`; full Vitest suite with `--reporter=json` and confirm `success: true` (the summary line can mask suite-level collection failures — do not trust `FAIL (0)` alone).
3. Optionally run `/code-review` on the diff for an independent pass on large phases.
4. **Feed findings back:** use `SendMessage` to the responsible implementer agents (they retain context) with concrete, file-level corrections. Spawn fresh fix agents only if the original is unsuitable. Iterate Stages 3–4 until the diff passes your review AND the full suite is green. Do not "fix it yourself" beyond trivial mechanical corrections — the loop exists so the work product is the agents'.

### Stage 5 — Browser validation (only if the phase touches UI)

1. Deploy the worktree build via the `docker-dev-deployer` agent (or `/deploy`), including the dev.local override.
2. Load `http://localhost:8080/meshmonitor` with the chrome-devtools MCP tools. Log in (`admin`/`changeme`; login is rate-limited — do not brute-force, query SQLite directly if you need state).
3. Exercise every changed screen/flow: navigate, click, fill, verify rendered results match the spec. Take screenshots of the changed UI. Check `list_console_messages` for new errors/warnings.
4. Any test messages go on the `gauntlet` channel — never Primary.
5. Findings loop back through Stage 4 (dispatch fixes, re-review, re-deploy, re-validate).
6. Only one dev container at a time — tear down before another phase deploys, and never alongside a local `npm run dev`.

### Stage 6 — Documentation

Once you are satisfied with the work product:

- Review the published documentation for required changes: `README.md`, `docs/`, API docs, and `CLAUDE.md`/dev-notes if the phase changed an invariant or recipe. Use the `meshmonitor-docs-writer` agent for substantial doc work; do small updates directly.
- Update the epic plan doc: check off the phase, record decisions/deviations made during the phase.
- Commit docs + plan updates in the phase branch.

### Stage 7 — Ship

1. Push the branch (`git push origin <branch>` — branch ref, no checkout of main needed).
2. Create the PR with `/create-pr` (it runs validation and writes the PR body). Reference the epic's issue and phase number.
3. Monitor with `/ci-monitor` and use the existing processes to resolve findings: it auto-fixes CI failures; a failed Claude Code Review check is usually transient auth (`~/Development/homelab/tools/gh-secret.sh`, then rerun); background CI watchers can lose network — trust the output file's final EXIT line, not the task exit code.
4. Address review findings by dispatching fixes through the Stage 3/4 loop (commits to the same branch), not by hand-editing.
5. When CI is green and findings are resolved, **merge via `/merge`** (it fast-forwards local main and cleans up the worktree/branch).

### Stage 8 — Advance

- Mark the phase task completed. Post the user a short phase summary: what shipped (PR link), deviations from plan, what's next.
- Proceed to the next phase (Stage 1, fresh worktree from the now-updated `origin/main`). Do not carry uncommitted state between phases.

---

## Stop conditions — surface to the user instead of proceeding

- A scope change or contradiction with the interview answers/epic plan emerges mid-phase.
- Anything destructive or irreversible beyond the normal branch/PR/merge flow.
- CI or review findings survive **3 full fix iterations** — stop, summarize the impasse, ask.
- The phase needs real device hardware/system-test behavior you cannot validate (system-test label only on explicit request or device-comms changes).
- Budget/scale surprise: a phase decomposes into far more work packages than the plan implied.

## Long-run hygiene

- The epic plan doc + task list are the source of truth, not conversation memory — update them at every phase boundary so a compacted or restarted session can resume cleanly.
- Another session may switch branches in the primary checkout — all epic work stays in phase worktrees; push and PR by branch ref only.
- Keep per-phase agent counts sane: architect (1) + implementers (typically 2–6) + fix iterations. If a phase wants more, the phase is too big — split it and update the plan.

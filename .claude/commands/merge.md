---
name: merge
description: Merge an approved/green PR, fast-forward local main, and clean up the worktree/branch — the full "Merge it" sequence, safe under concurrent shared-checkout sessions.
---

Merge a PR and leave the workspace clean. This bundles the post-merge hygiene that's otherwise re-done by hand every time.

## Arguments
$ARGUMENTS

A PR number (e.g. `3621` / `#3621`). If omitted, resolve it from the current branch: `gh pr view --json number,headRefName,state,mergeStateStatus`.

## Step 1: Pre-merge gate

Do NOT merge a red or unreviewed PR unless the user explicitly said so.

```bash
gh pr view <PR> --json number,title,state,mergeStateStatus,reviewDecision,headRefName,statusCheckRollup \
  -q '{num:.number,title:.title,state:.state,merge:.mergeStateStatus,review:.reviewDecision,branch:.headRefName}'
```

- `state` must be `OPEN`.
- CI green (`mergeStateStatus` not `BLOCKED`/`DIRTY`/`BEHIND`; `statusCheckRollup` all `SUCCESS`/skipped).
- If there are merge conflicts (`DIRTY`/`BEHIND`), STOP and report — the branch needs a rebase/merge first, which is the user's call.
- Capture `headRefName` — you'll need it for cleanup.

## Step 2: Merge

This repo squash-merges (PR titles in history read `feat(scope): … (#NNNN)`). Merge and delete the remote branch in one shot:

```bash
gh pr merge <PR> --squash --delete-branch
```

If the user asked for a different method, honor it (`--merge` / `--rebase`).

## Step 3: Fast-forward local `main`

The primary checkout's `main` drifts behind `origin/main` after every merge. Bring it current — but this is a **shared working directory** that other sessions may be using, and `.claude/agent-memory/` carries untracked files that a checkout would trip over. Stash those first, fast-forward, then restore:

```bash
git fetch origin main
git stash push -u -m "pre-ff-agent-memory" -- .claude/agent-memory/ 2>/dev/null || true
git checkout main && git merge --ff-only origin/main
git stash pop 2>/dev/null || true
```

- Use `--ff-only` — never create a merge commit on `main`, and never `git push` to `main`.
- If `--ff-only` fails, local `main` has diverged (someone committed to it directly). STOP and report rather than forcing.
- If another session has the checkout on a different branch and switching would disrupt it, note that and ask before changing branches.

## Step 4: Clean up the worktree / branch

If the work was done in a worktree:
```bash
git worktree list                       # find the worktree backing <headRefName>
git worktree remove <path>              # NOT --force unless the user OKs uncommitted changes
git worktree prune
```
If it was a local branch in this checkout (now merged), delete it:
```bash
git branch -d <headRefName>             # -d (safe); never -D without asking
```
For anything non-trivial (multiple worktrees, uncommitted changes), defer to **`/worktree-cleanup`** and let it confirm with the user.

## Step 5: Report

- PR merged (number + title), merge method.
- Local `main` fast-forwarded to `<short-sha>` (or why it couldn't be).
- Worktree/branch cleaned up (or left, with reason).
- Surface any `/schedule`-worthy follow-up only if the merged work left a concrete dated obligation (flag ramp, `.skip` removal) — otherwise don't.

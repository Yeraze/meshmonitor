# Git Worktrees for Parallel Development

## What Are Git Worktrees?

Git worktrees allow you to check out **multiple branches simultaneously** into separate directories, all sharing the same Git history. This enables running multiple Claude Code sessions in parallel without branch switching or merge conflicts.

## Why Use Worktrees with Claude Code?

### The Problem Without Worktrees
```bash
# Traditional workflow - one task at a time
git checkout feature-a
# Work on feature-a...
git stash              # Need to switch
git checkout bugfix-b
# Work on bugfix-b...
git stash pop          # Back to feature-a
# Context switching overhead!
```

### The Solution With Worktrees
```bash
# Parallel workflow - multiple tasks simultaneously
cd ~/meshmonitor-feature-a    # Claude session 1
cd ~/meshmonitor-bugfix-b     # Claude session 2
# Both work independently, no conflicts!
```

## Key Benefits

1. **True Parallel Work**
   - Run multiple Claude sessions simultaneously
   - Each on different branches in separate folders
   - No git stash dance or context switching

2. **Clean Context per Task**
   - Each Claude session focused on one goal
   - Isolated file states prevent interference
   - Shared Git history and remote connections

3. **Non-Deterministic AI Advantage**
   - Generate multiple implementations of same feature
   - Compare different approaches side-by-side
   - Pick the best solution (official Anthropic pattern)

4. **Efficient Resource Usage**
   - Lightweight - just directory pointers
   - Shares .git repository (no duplication)
   - Each worktree needs `npm install` once

## Directory Structure

```
# Before worktrees
~/meshmonitor/
  ├── .git/
  ├── src/
  └── package.json

# After creating worktrees
~/
├── meshmonitor/                    # Main worktree (main branch)
│   ├── .git/                       # Actual Git repository
│   ├── src/
│   └── package.json
├── meshmonitor-feature-reactions/  # Worktree 1 (feature branch)
│   ├── .git                        # Link file to main .git
│   ├── src/                        # Independent file state
│   └── package.json
└── meshmonitor-fix-websocket/      # Worktree 2 (bugfix branch)
    ├── .git                        # Link file to main .git
    ├── src/
    └── package.json
```

## Basic Commands

### Create a Worktree
```bash
# From main repository
cd ~/meshmonitor

# Create worktree with new branch
git worktree add ../meshmonitor-feature-reactions -b feature/emoji-reactions

# Or from existing branch
git worktree add ../meshmonitor-hotfix hotfix/session-bug
```

**Syntax:**
```bash
git worktree add <path> [-b <new-branch>] [<base-branch>]
```

### List Worktrees
```bash
git worktree list
# Output:
# /Users/you/meshmonitor           abc123 [main]
# /Users/you/meshmonitor-feature-a def456 [feature/reactions]
# /Users/you/meshmonitor-fix-b     ghi789 [fix/websocket]
```

### Remove Worktree
```bash
# After work is merged
git worktree remove ../meshmonitor-feature-reactions

# Force remove (if needed)
git worktree remove --force ../meshmonitor-feature-reactions

# Clean up branch
git branch -d feature/emoji-reactions
```

### Prune Stale Worktrees
```bash
# Remove references to deleted worktrees
git worktree prune
```

## MeshMonitor Workflows

### Workflow 1: Feature + Bugfix in Parallel

**Setup:**
```bash
cd ~/meshmonitor

# Create feature worktree
git worktree add ../meshmonitor-feature-search -b feature/message-search

# Create bugfix worktree  
git worktree add ../meshmonitor-fix-dedup -b fix/message-deduplication
```

**Work:**
```bash
# Terminal 1
cd ~/meshmonitor-feature-search
npm install  # First time only
claude

# Terminal 2
cd ~/meshmonitor-fix-dedup
npm install  # First time only
claude
```

**In each Claude session:**
```
"Read .claude/pr-prep.md and .claude/testing-guide.md.

Task: [Implement message search / Fix message deduplication]

Plan the work:
1. Understand requirements
2. Create failing tests first
3. Implement in small chunks
4. Run tests after each change
5. Commit with conventional commits

Use meshmonitor-test-generator for tests.
Use meshmonitor-pr-reviewer before final commit."
```

**Merge:**
```bash
# After both tasks complete
cd ~/meshmonitor-feature-search
git push -u origin feature/message-search
# Create PR on GitHub

cd ~/meshmonitor-fix-dedup
git push -u origin fix/message-deduplication
# Create PR on GitHub

# After PRs merged, cleanup
cd ~/meshmonitor
git worktree remove ../meshmonitor-feature-search
git worktree remove ../meshmonitor-fix-dedup
git branch -d feature/message-search
git branch -d fix/message-deduplication
```

### Workflow 2: Multiple Implementation Variants

**Use Case:** Generate different approaches, pick the best

```bash
cd ~/meshmonitor

# Create 3 worktrees for same feature
git worktree add ../meshmonitor-reactions-v1 -b feature/reactions-variant-1
git worktree add ../meshmonitor-reactions-v2 -b feature/reactions-variant-2
git worktree add ../meshmonitor-reactions-v3 -b feature/reactions-variant-3
```

**Run same prompt in all 3:**
```bash
# Terminal 1, 2, 3
cd ~/meshmonitor-reactions-v[1/2/3]
npm install
claude
```

**Same prompt to each:**
```
"Implement emoji reactions for message bubbles.
Use the specification in GitHub issue #123.
Create tests first, then implementation.
Use Catppuccin Mocha theme."
```

**Review results:**
```bash
# Compare implementations
code --diff ~/meshmonitor-reactions-v1/src ~/meshmonitor-reactions-v2/src

# Run tests in each
cd ~/meshmonitor-reactions-v1 && npm run test:run
cd ~/meshmonitor-reactions-v2 && npm run test:run
cd ~/meshmonitor-reactions-v3 && npm run test:run

# Pick the best one (e.g., v2)
cd ~/meshmonitor-reactions-v2
git push -u origin feature/reactions-variant-2
# Create PR

# Cleanup the others
cd ~/meshmonitor
git worktree remove ../meshmonitor-reactions-v1
git worktree remove ../meshmonitor-reactions-v3
git branch -d feature/reactions-variant-1
git branch -d feature/reactions-variant-3
```

### Workflow 3: Long-Running Feature + Quick Fixes

```bash
# Main work in progress
cd ~/meshmonitor-major-refactor
# Claude session running long task...

# Hot bug comes in
cd ~/meshmonitor
git worktree add ../meshmonitor-hotfix-now -b hotfix/critical-bug
cd ~/meshmonitor-hotfix-now
npm install
claude
# Fix bug quickly

# Push hotfix
git push -u origin hotfix/critical-bug
# Create PR, get merged

# Cleanup
cd ~/meshmonitor
git worktree remove ../meshmonitor-hotfix-now
git branch -d hotfix/critical-bug

# Back to long-running feature
cd ~/meshmonitor-major-refactor
# Continue where you left off
```

## Setup Requirements per Worktree

Each new worktree needs one-time setup:

### For MeshMonitor
```bash
cd ~/meshmonitor-new-worktree

# Install dependencies
npm install

# Initialize git submodules (MeshMonitor uses protobufs)
git submodule update --init

# Copy environment if needed
cp ~/meshmonitor/.env .env

# Ready to work!
claude
```

### Automation Script
```bash
#!/bin/bash
# setup-meshmonitor-worktree.sh

WORKTREE_DIR=$1

cd "$WORKTREE_DIR"
npm install
git submodule update --init
cp ~/meshmonitor/.env .env 2>/dev/null || true
echo "✅ Worktree ready: $WORKTREE_DIR"
```

Usage:
```bash
git worktree add ../meshmonitor-feature-x -b feature/x
./setup-meshmonitor-worktree.sh ../meshmonitor-feature-x
cd ../meshmonitor-feature-x
claude
```

## Best Practices

### Naming Convention
```bash
# Good - descriptive, clear purpose
git worktree add ../meshmonitor-feature-emoji-reactions -b feature/emoji-reactions
git worktree add ../meshmonitor-fix-websocket-conflict -b fix/websocket-conflict
git worktree add ../meshmonitor-docs-api-reference -b docs/api-reference

# Avoid - too generic
git worktree add ../meshmonitor-temp -b temp
git worktree add ../meshmonitor-2 -b feature2
```

### One Task per Worktree
```bash
# ✅ Good - focused
feature/add-message-search
fix/deduplication-bug

# ❌ Bad - too broad
feature/improve-everything
refactor/misc-changes
```

### Clean Up Regularly
```bash
# Weekly cleanup
git worktree list
git worktree prune

# Remove merged worktrees
git worktree remove ../meshmonitor-feature-old
git branch -d feature-old
```

### Keep Main Worktree Clean
```bash
# Use main worktree for:
# - Reviewing PRs
# - Running full test suite
# - Building releases

# Don't use main worktree for:
# - Feature development (use worktrees)
# - Experimental work (use worktrees)
```

## Integration with Claude Code

### Starting Claude in Worktree
```bash
cd ~/meshmonitor-feature-x
claude

# Claude knows about git context
"What branch am I on?"
# Worktree provides: feature-x

"What files changed?"
# Shows only this worktree's changes
```

### Using Subagents in Worktrees
```bash
# In worktree directory
cd ~/meshmonitor-feature-search

claude
# Inside Claude session:
"Use meshmonitor-test-generator to create search tests"
"Use meshmonitor-pr-reviewer to verify my changes"
```

**Important:** Each worktree shares `.claude/` directory from main repo, so subagents and context files are available everywhere!

### Plan Mode in Worktrees
```bash
claude --plan "Analyze how to implement message search"
# Plan mode is read-only, perfect for exploration
# Then switch to normal mode for implementation
```

## Common Scenarios

### Scenario: Context Switching Avoided
```bash
# Without worktrees - painful
git stash
git checkout other-branch
# Do work
git checkout original-branch
git stash pop

# With worktrees - smooth
cd ../meshmonitor-other-branch
# Do work
cd ../meshmonitor-original-branch
# Back where you were, no stashing
```

### Scenario: Parallel Test Runs
```bash
# Terminal 1
cd ~/meshmonitor-feature-a
npm run test:run

# Terminal 2
cd ~/meshmonitor-feature-b
npm run test:run

# Both run independently!
```

### Scenario: Comparing Implementations
```bash
# Visual diff
code --diff ~/meshmonitor-v1 ~/meshmonitor-v2

# Or open both in VS Code
code ~/meshmonitor-v1
code ~/meshmonitor-v2
# Side-by-side comparison
```

## Troubleshooting

### Issue: Can't Create Worktree
```bash
# Error: 'feature/x' is already checked out at '...'
# Solution: Branch can only be checked out once
git worktree list  # Find where it's checked out
git worktree remove <path>  # Remove old worktree
```

### Issue: npm install Fails
```bash
# Each worktree needs its own node_modules
cd ~/meshmonitor-feature-x
rm -rf node_modules package-lock.json
npm install
```

### Issue: Submodules Not Initialized
```bash
# MeshMonitor uses git submodules for protobufs
cd ~/meshmonitor-feature-x
git submodule update --init
```

### Issue: Out of Sync with Remote
```bash
cd ~/meshmonitor-feature-x

# Fetch latest
git fetch origin

# Rebase on main
git rebase origin/main

# Or merge
git merge origin/main
```

### Issue: Forgot Which Worktree for Which Task
```bash
# List all worktrees with branches
git worktree list

# Or check branch in specific worktree
cd ~/meshmonitor-feature-x
git branch --show-current
```

## Advanced: Automation

### Custom Claude Command: /worktree

Create `.claude/commands/worktree.md`:
```markdown
---
name: worktree
description: Create a git worktree and set it up for MeshMonitor development
---

Create a git worktree for MeshMonitor:

1. Get task name from user: $ARGUMENTS (kebab-case)
2. Create branch name: feature/$ARGUMENTS or fix/$ARGUMENTS
3. Run: `git worktree add ../meshmonitor-$ARGUMENTS -b <branch-name>`
4. Change to new worktree directory
5. Run setup:
   - `npm install`
   - `git submodule update --init`
   - Copy `.env` from main worktree
6. Report success and next steps
```

Usage:
```bash
claude
"/worktree emoji-reactions"
# Claude creates worktree and sets it up
```

### Fish/Bash Helper Function

```bash
# Add to ~/.bashrc or ~/.config/fish/config.fish

function mm-worktree --description "Create MeshMonitor worktree"
    set task_name $argv[1]
    set branch_name "feature/$task_name"
    
    # Create worktree
    git worktree add ../meshmonitor-$task_name -b $branch_name
    
    # Setup
    cd ../meshmonitor-$task_name
    npm install
    git submodule update --init
    cp ~/meshmonitor/.env .env 2>/dev/null || true
    
    # Start Claude
    claude
end
```

Usage:
```bash
mm-worktree emoji-reactions
# Creates, sets up, starts Claude automatically
```

## Quick Reference

```bash
# Create
git worktree add ../meshmonitor-<task> -b feature/<task>

# Setup
cd ../meshmonitor-<task>
npm install
git submodule update --init

# Work
claude

# Push
git push -u origin feature/<task>

# Cleanup
cd ~/meshmonitor
git worktree remove ../meshmonitor-<task>
git branch -d feature/<task>
```

## Integration with PR Workflow

Worktrees fit perfectly into MeshMonitor's PR workflow:

1. **Create worktree** → New branch isolated
2. **Develop with Claude** → Focus on single task
3. **Run PR reviewer** → `meshmonitor-pr-reviewer` subagent
4. **Push branch** → From worktree directory
5. **Create PR on GitHub** → Standard process
6. **After merge** → Remove worktree, delete branch
7. **Pull main** → In main worktree only

This keeps your main worktree pristine and focused on reviewing/releasing.

---

**Pro Tip:** Start with 2-3 worktrees max until you're comfortable. The pattern scales, but simplicity wins early on. Focus on the workflow, not worktree management!

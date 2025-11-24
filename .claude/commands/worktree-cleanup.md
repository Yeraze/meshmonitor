---
name: worktree-cleanup
description: Clean up merged worktrees and their branches
---

Clean up git worktrees that have been merged into main.

## Process

1. **Fetch latest updates:**
   ```bash
   git fetch origin
   ```

2. **Identify merged worktrees:**
   - List all worktrees: `git worktree list`
   - For each worktree (excluding the main one):
     - Get its branch name
     - Check if merged into `origin/main`: `git branch -r --merged origin/main | grep <branch-name>`

3. **Present candidate list to user:**
   - Show list of worktrees backed by merged branches.
   - **STOP and ask for confirmation:** "Do you want to remove these worktrees and delete their branches? (y/n)"

4. **Execute cleanup (only if confirmed):**
   - For each confirmed worktree:
     a. Remove worktree: `git worktree remove <path>`
     b. Delete branch: `git branch -d <branch-name>`
   - If `git worktree remove` fails due to uncommitted changes:
     - Report it to the user.
     - Ask if they want to force remove.

5. **Prune stale references:**
   ```bash
   git worktree prune
   ```

6. **Manual Directory Cleanup (if needed):**
   - If a directory remains after removal, delete it using the system command:
     - **Windows (PowerShell):** `Remove-Item -Recurse -Force <path>`
     - **Linux/Mac:** `rm -rf <path>`

## Safety Checks

- **CRITICAL:** Never remove the main worktree (the one with the `.git` directory inside).
- **Confirmation:** Always list what will be deleted and wait for user approval.
- **Uncommitted Changes:** Respect git's warnings about modified files. Only use `--force` if the user explicitly authorizes it after the warning.

## Common Issues

**Issue:** "fatal: '<path>' contains modified or untracked files"
**Solution:**
1. Tell the user: "Worktree at <path> has uncommitted changes."
2. Ask: "Do you want to force delete it? (y/n)"
3. If yes: `git worktree remove --force <path>`

**Issue:** Directory still exists after removal
**Solution:**
Use the appropriate system command to remove the empty directory (e.g., `Remove-Item` on Windows).

## Dry Run Option

If user wants to see what would be cleaned without actually doing it:

```bash
# Show what would be removed (don't actually remove)
git branch --merged main
git worktree list

# Report planned actions without executing
```

## Integration with MeshMonitor Workflow

After PR is merged on GitHub:

1. Pull latest main in primary worktree
2. Run `/worktree-cleanup` to remove merged worktrees
3. Verify with `git worktree list`
4. Continue with next task

Keeps your workspace tidy and focused on active work!

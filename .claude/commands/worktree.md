---
name: worktree
description: Create a git worktree for MeshMonitor with automatic setup
---

Create and set up a git worktree for MeshMonitor development.

## Task Name
User provided: $ARGUMENTS

If the user provided a clear kebab-case task name, use it.
Otherwise, convert their input to kebab-case (lowercase, hyphens instead of spaces).

## Steps

1. **Determine branch type and name:**
   - If task sounds like a bug/fix: `fix/<task-name>`
   - If task sounds like documentation: `docs/<task-name>`
   - Otherwise: `feature/<task-name>`

2. **Check for existing worktree:**
   ```bash
   if [ -d "../meshmonitor-<task-name>" ]; then
       echo "Error: Directory ../meshmonitor-<task-name> already exists."
       exit 1
   fi
   ```

3. **Create the worktree:**
   ```bash
   git worktree add ../meshmonitor-<task-name> -b <branch-type>/<task-name>
   ```

4. **Set up the worktree:**
   ```bash
   cd ../meshmonitor-<task-name>
   npm install
   git submodule update --init
   ```

5. **Copy environment file (if exists):**
   ```bash
   # Copy from the original workspace (parent of current worktree or current dir)
   if [ -f "../meshmonitor/.env" ]; then
       cp "../meshmonitor/.env" .env
   elif [ -f "../.env" ]; then
       cp "../.env" .env
   elif [ -f ".env" ]; then
       cp ".env" .env
   fi
   ```

6. **Verify setup:**
   ```bash
   git branch --show-current
   npm run typecheck
   ```

7. **Report to user:**
   ```
   ✅ Worktree created and ready:
   
   Location: ../meshmonitor-<task-name>
   Branch: <branch-type>/<task-name>
   
   Next steps:
   1. cd ../meshmonitor-<task-name>
   2. Start a new Claude session: claude
   3. Begin work on: <task description>
   ```

## Examples

**Input:** `emoji reactions`
**Creates:** 
- Worktree: `../meshmonitor-emoji-reactions`
- Branch: `feature/emoji-reactions`

**Input:** `websocket session bug`
**Creates:**
- Worktree: `../meshmonitor-websocket-session-bug`
- Branch: `fix/websocket-session-bug`

**Input:** `update kubernetes docs`
**Creates:**
- Worktree: `../meshmonitor-update-kubernetes-docs`
- Branch: `docs/update-kubernetes-docs`

## Error Handling

If worktree creation fails:
- Check if branch already exists: `git branch -a | grep <branch-name>`
- Check if worktree directory exists: `ls -la ../meshmonitor-<task-name>`
- Suggest using different task name or cleaning up old worktree

If npm install fails:
- Check Node version: `node --version` (must be 20+)
- Suggest clearing cache: `npm cache clean --force`

If submodule init fails:
- Check if .gitmodules exists
- Suggest manual init: `git submodule update --init --recursive`

## Notes

- Each worktree needs its own `npm install` (node_modules not shared)
- All worktrees share the same .git repository
- The `.claude/` directory is shared across all worktrees
- Submodules (protobufs) must be initialized per worktree
- Environment variables (.env) should be copied from main

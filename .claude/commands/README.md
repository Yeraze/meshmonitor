# MeshMonitor Custom Claude Code Commands

This directory contains custom slash commands for Claude Code to streamline MeshMonitor development workflows.

## What Are Custom Commands?

Custom commands are reusable prompt templates that become available through the `/` slash menu in Claude Code. They can:
- Automate repetitive workflows
- Standardize common tasks
- Accept parameters via `$ARGUMENTS`
- Be shared across the team via git

## Available Commands

### /worktree
**Create a git worktree with automatic setup**

Creates a new git worktree for parallel development, sets up dependencies, and optionally opens a new terminal.

**Usage:**
```bash
/worktree emoji reactions
/worktree websocket bug fix
/worktree update api docs
```

**What it does:**
1. Converts task name to kebab-case
2. Determines branch type (feature/fix/docs)
3. Creates worktree in peer directory
4. Runs `npm install`
5. Initializes git submodules
6. Copies .env file
7. Reports next steps

**Example:**
```bash
/worktree message search

# Creates:
# - Worktree: ../meshmonitor-message-search
# - Branch: feature/message-search
# - Runs setup automatically
```

---

### /worktree-cleanup
**Clean up merged worktrees and branches**

Removes worktrees that have been merged into main and deletes their associated branches.

**Usage:**
```bash
/worktree-cleanup
```

**What it does:**
1. Lists all worktrees
2. Identifies merged branches
3. Asks for confirmation
4. Removes merged worktrees
5. Deletes merged branches
6. Prunes stale references
7. Reports summary

**Safety features:**
- Never removes main worktree
- Warns about uncommitted changes
- Asks for confirmation before deleting
- Provides dry-run information

---

## Installation

### Project-Level (Recommended for MeshMonitor)
Commands are already in `.claude/commands/` and committed to git:
```bash
# They're already here!
.claude/commands/
├── README.md
├── worktree.md
└── worktree-cleanup.md
```

When you run `claude` in the meshmonitor directory, these commands are automatically available.

### User-Level (Personal Commands)
For personal commands you want across all projects:
```bash
mkdir -p ~/.claude/commands
cp your-command.md ~/.claude/commands/
```

## Using Commands

### In Claude Code Session
```bash
claude

# Type / to see available commands
> /

# Available commands:
# /worktree - Create git worktree
# /worktree-cleanup - Clean up merged worktrees
# ... (other commands)

# Use with arguments
> /worktree emoji reactions

# Or without arguments (interactive)
> /worktree-cleanup
```

### From Command Line
```bash
# Non-interactive mode
claude --print "/worktree message-threading"

# Continue previous session with command
claude --continue --print "/worktree-cleanup"
```

## Creating Your Own Commands

### Basic Template
Create `.claude/commands/my-command.md`:

```markdown
---
name: my-command
description: Brief description of what this command does
---

Main prompt template goes here.

You can use $ARGUMENTS to accept parameters.

## Examples
Show usage examples here.
```

### With Arguments
```markdown
---
name: fix-issue
description: Analyze and fix a GitHub issue
---

Analyze and fix GitHub issue: $ARGUMENTS

Steps:
1. Use `gh issue view $ARGUMENTS` to get details
2. Search codebase for relevant files
3. Implement the fix
4. Create tests
5. Commit and create PR
```

Usage: `/fix-issue 123`

### Best Practices

1. **Clear descriptions** - Help Claude know when to suggest the command
2. **Structured prompts** - Use numbered steps or sections
3. **Examples included** - Show expected usage
4. **Error handling** - Account for common failure cases
5. **MeshMonitor-specific** - Reference our context files

### MeshMonitor Command Template
```markdown
---
name: command-name
description: When to use this command
---

Brief overview of what this command does for MeshMonitor.

## Context
Reference relevant .claude/*.md files:
- Read .claude/architecture-notes.md for system context
- Follow .claude/testing-guide.md for test patterns
- Use .claude/pr-prep.md for commit standards

## Steps
1. First step
2. Second step
3. ...

## MeshMonitor-Specific Considerations
- TCP protocol patterns
- Catppuccin Mocha theme
- SQLite database
- Test requirements (100% pass)
- Conventional commits

## Examples
Show usage examples specific to MeshMonitor.

## Error Handling
Account for common MeshMonitor-specific issues.
```

## Command Ideas for MeshMonitor

Consider creating commands for:

### /implement-feature
Full feature implementation workflow:
- Plan with tests first
- Implement incrementally
- Run tests after each chunk
- Update docs
- Review before PR

### /fix-bug
Systematic bug fixing:
- Reproduce the issue
- Create failing test
- Fix the bug
- Verify test passes
- Add regression test

### /update-docs
Documentation updates:
- Update README for features
- Add API documentation
- Update environment variables
- Create PR description

### /release-prep
Prepare for release:
- Run full test suite
- Build Docker image
- Update changelog
- Tag version
- Create release notes

## Integration with Subagents

Commands can invoke subagents:

```markdown
---
name: full-review
description: Complete PR review workflow
---

Comprehensive PR review for MeshMonitor:

1. Use meshmonitor-test-generator to verify test coverage
2. Use meshmonitor-pr-reviewer to check standards
3. Use meshmonitor-docs-writer to verify documentation
4. Provide final go/no-go recommendation

Report findings in structured format.
```

## Testing Commands

### Test Locally
```bash
claude
> /my-command test-arg

# Verify:
# - Does it understand $ARGUMENTS?
# - Does it execute the right steps?
# - Does it handle errors gracefully?
```

### Iterate
Commands are just markdown files - edit and retry:
```bash
# Edit
vim .claude/commands/my-command.md

# Restart Claude to reload
exit
claude
> /my-command
```

## Sharing Commands

### With Team
Commands in `.claude/commands/` are committed to git:
```bash
git add .claude/commands/new-command.md
git commit -m "chore: add /new-command for X workflow"
git push
```

Team members get them automatically:
```bash
git pull
claude  # Commands now available
```

### With Community
Share useful patterns:
1. Create gist or repo
2. Document clearly
3. Link from README
4. Accept contributions

## Commands vs. Subagents

**Use Commands when:**
- Workflow is procedural (step 1, 2, 3...)
- Need to invoke multiple subagents
- Templating repetitive prompts
- Automating git operations

**Use Subagents when:**
- Task needs independent context
- Specialized expertise required
- Running in parallel
- Complex reasoning needed

**Use Both:**
Commands can orchestrate subagents for powerful workflows!

## Troubleshooting

### Command Not Showing in Menu
```bash
# Check file location
ls .claude/commands/

# Check YAML frontmatter
head .claude/commands/my-command.md

# Restart Claude
exit
claude
```

### $ARGUMENTS Not Working
```markdown
# Correct usage
"Process task: $ARGUMENTS"

# Incorrect
"Process task: {ARGUMENTS}"
"Process task: %ARGUMENTS%"
```

### Command Doesn't Do What Expected
- Review the prompt template
- Add more specific instructions
- Test with different arguments
- Check error handling

## Resources

- [Official Commands Documentation](https://docs.anthropic.com/en/docs/claude-code/common-workflows)
- [Best Practices](https://www.anthropic.com/engineering/claude-code-best-practices)
- `.claude/worktree-guide.md` - Git worktree workflows
- `.claude/git-workflow.md` - Git conventions

---

**Pro Tip:** Start with the provided `/worktree` and `/worktree-cleanup` commands, then create more as you discover repetitive workflows. The best commands emerge from real usage patterns!

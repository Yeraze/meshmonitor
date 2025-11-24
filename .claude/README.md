# Claude Code AI Agent Configuration

This directory contains configuration and documentation for AI-assisted development with Claude Code.

## Quick Navigation

### 📘 [instructions.md](./instructions.md) - **START HERE**
Main AI agent instructions with essential project context.
- Quick start commands
- Architecture essentials
- Git workflow & testing
- PR requirements

### 🔧 [development.md](./development.md)
Testing, commit messages, and PR preparation.
- Test commands & patterns
- Commit message templates
- PR templates & checklists
- Common workflows

### 🏗️ [architecture-notes.md](./architecture-notes.md)
System architecture quick reference.
- TCP protocol details
- Database schema
- API endpoints
- Design decisions

### 🤖 [agents/](./agents/)
Specialized AI agents for specific tasks:
- **code-reviewer.md** - Pre-PR review automation
- **test-generator.md** - Comprehensive test generation
- **docs-writer.md** - Documentation creation
- **bug-investigator.md** - Systematic debugging

## For Developers

**Human developers**: Start with the devcontainer setup in `.devcontainer/README.md`, then read `instructions.md` for project conventions.

**AI agents**: Read `instructions.md` first for critical constraints, then reference other files as needed. Always check `docs/ARCHITECTURE_LESSONS.md` before implementing node communication or state management.

## File Sizes (Kept Concise)

```
instructions.md        279 lines  (core essentials)
development.md         126 lines  (workflows & templates)
architecture-notes.md  172 lines  (technical reference)
                       ---
Total:                 577 lines  (maintainable)
```

## Maintenance Guidelines

**Update when:**
- Architecture patterns change
- New critical constraints added
- Testing requirements evolve
- PR process changes

**Don't update for:**
- Minor version bumps (mention in changelog instead)
- Small config tweaks
- Routine bug fixes
- Dependency updates

## See Also

- `/workspace/docs/ARCHITECTURE_LESSONS.md` - **MUST READ** before touching node communication
- `/workspace/.devcontainer/README.md` - Devcontainer setup and usage
- `/workspace/CONTRIBUTING.md` - Contribution guidelines
- `/workspace/CLAUDE.md` - Project-specific AI agent instructions

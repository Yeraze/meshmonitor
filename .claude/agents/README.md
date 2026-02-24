# MeshMonitor Claude Code Subagents

This directory contains specialized AI subagents for MeshMonitor development in Claude Code.

## What Are Subagents?

Subagents are specialized AI assistants with:
- **Isolated context** - Separate from main conversation
- **Specific expertise** - Tailored for particular tasks
- **Custom tools** - Limited tool access for safety
- **Focused prompts** - Optimized for their domain

## Available Subagents

### 🔍 meshmonitor-pr-reviewer
**Use before creating PRs**

Reviews code against MeshMonitor requirements:
- Testing (100% pass rate, Vitest patterns)
- Code quality (TypeScript, ESLint, no debug artifacts)
- Commit standards (conventional commits)
- Documentation updates

**Invoke with:**
```bash
"Use meshmonitor-pr-reviewer to check my changes before I create a PR"
```

**Tools:** read, grep, bash

---

### 🧪 meshmonitor-test-generator
**Use when implementing features or fixing bugs**

Generates comprehensive test suites:
- Unit tests for services/utilities
- Component tests for React UI
- Integration tests for APIs
- MeshMonitor-specific mock data

**Invoke with:**
```bash
"Use meshmonitor-test-generator to create tests for the message threading feature"
```

**Tools:** read, write, bash, grep

---

### 🐛 meshmonitor-bug-investigator
**Use when debugging issues**

Systematically investigates bugs:
- Reproduces the issue
- Analyzes root cause
- Proposes minimal fix
- Creates regression test

**Invoke with:**
```bash
"Use meshmonitor-bug-investigator to debug the WebSocket session conflict"
```

**Tools:** read, grep, bash, write

---

### 📝 meshmonitor-docs-writer
**Use when features need documentation**

Creates and updates documentation:
- README sections
- API documentation
- JSDoc comments
- PR descriptions

**Invoke with:**
```bash
"Use meshmonitor-docs-writer to document the new emoji reactions feature"
```

**Tools:** read, write, grep

## Installation

### Option 1: Project-Level (Recommended)
```bash
# In your meshmonitor repo root
mkdir -p .claude/agents
cp /path/to/these/files/*.md .claude/agents/

# Commit to repo
git add .claude/agents/
git commit -m "chore: add Claude Code subagents"
```

### Option 2: User-Level (Global)
```bash
# Available across all projects
mkdir -p ~/.claude/agents
cp /path/to/these/files/*.md ~/.claude/agents/
```

## Usage Examples

### Pre-PR Review Workflow
```bash
# Make your changes
git add src/

# Review before PR
"Use meshmonitor-pr-reviewer to verify my changes are PR-ready"

# Fix any issues found
# Create PR when clean
```

### Feature Development Workflow
```bash
# Implement feature
"Add emoji reactions to messages"

# Generate tests
"Use meshmonitor-test-generator to create comprehensive tests"

# Document it
"Use meshmonitor-docs-writer to add README section for reactions"

# Review everything
"Use meshmonitor-pr-reviewer to check before PR"
```

### Bug Fix Workflow
```bash
# Debug the issue
"Use meshmonitor-bug-investigator to analyze the WebSocket session bug"

# Implement the fix
[Apply suggested fix]

# Test automatically generated
[Regression test included in bug investigation]

# Document if needed
"Use meshmonitor-docs-writer to add troubleshooting section"
```

### Parallel Investigation
```bash
# Use multiple subagents simultaneously
"Use meshmonitor-bug-investigator to check the TCP connection issue
and use meshmonitor-test-generator to create tests for the database queries"
```

## Managing Subagents

### List Available Subagents
```bash
/agents
```

### Create New Subagent
```bash
/agents create
# Follow the interactive prompts
```

### Edit Existing Subagent
```bash
# Direct file editing
code .claude/agents/meshmonitor-pr-reviewer.md
```

## Subagent Configuration

Each subagent has YAML frontmatter:

```yaml
---
name: unique-agent-name          # kebab-case identifier
description: When to use this    # Helps Claude decide when to invoke
tools: read, write, bash, grep   # Limited tool access (optional)
model: sonnet                    # Model to use (optional)
---
```

### Tool Options
- `read` - View files and directories
- `write` - Create/edit files
- `bash` - Run shell commands
- `grep` - Search in files
- (omit tools field to inherit all tools)

### Model Options
- `sonnet` - Claude Sonnet 4.5 (default)
- `opus` - Claude Opus 4
- `haiku` - Claude Haiku (faster, cheaper)
- `inherit` - Use same model as main thread

## Best Practices

### When to Use Subagents
✅ **Do use** for:
- Specialized reviews (PR checks, security audits)
- Focused generation (tests, docs)
- Deep investigations (debugging)
- Parallel tasks (multiple analyses)

❌ **Don't use** for:
- Simple questions
- Iterative conversations
- Tasks needing context from main thread
- Quick one-off commands

### Writing Effective Invocations
```bash
# ✅ Good - Specific and clear
"Use meshmonitor-test-generator to create tests for the TCP frame parser"

# ❌ Too vague
"Use test generator"

# ✅ Good - Provides context
"Use meshmonitor-bug-investigator to debug why messages aren't 
deduplicating. The symptom is duplicate message IDs in the database."

# ❌ Missing context
"Debug the messages"
```

### Combining Subagents
```bash
# Sequential
"First use meshmonitor-bug-investigator to find the root cause,
then use meshmonitor-test-generator to create a regression test"

# Parallel
"Use meshmonitor-pr-reviewer for code quality and 
meshmonitor-docs-writer for API documentation"
```

## Customization

### Modify Existing Subagents
Edit the markdown files directly:
1. Change the description to adjust when it's invoked
2. Modify the system prompt for different behavior
3. Adjust tool access for security
4. Update with new project patterns

### Create Project-Specific Variants
```bash
# Example: Create a deployment-focused subagent
cp .claude/agents/meshmonitor-pr-reviewer.md \
   .claude/agents/meshmonitor-deployment-checker.md

# Edit to focus on deployment concerns
```

## Troubleshooting

### Subagent Not Being Invoked
- Check description field is clear about when to use
- Make your request more specific
- Explicitly request the subagent by name

### Subagent Lacks Context
- Ensure it has necessary tool access
- Provide more information in your request
- Consider if main thread conversation is better

### Subagent Output Too Generic
- Make the system prompt more specific
- Add MeshMonitor-specific examples
- Reference actual code patterns from the repo

## Integration with Context Files

Subagents work alongside `.claude/*.md` context files:

**Context files** (in `.claude/`):
- Static reference documentation
- Always available to main Claude
- Architectural knowledge
- Standards and patterns

**Subagents** (in `.claude/agents/`):
- Active task execution
- Isolated context windows
- Specialized workflows
- Parallel processing

Use both together for maximum effectiveness!

## Contributing

Found a better prompt? Discovered a useful subagent pattern? 

1. Edit the relevant `.md` file
2. Test with actual development work
3. Create PR with improvements
4. Share with the team

## Resources

- [Official Subagents Docs](https://docs.anthropic.com/en/docs/claude-code/sub-agents)
- [Claude Code Best Practices](https://www.anthropic.com/engineering/claude-code-best-practices)
- [Community Subagents](https://subagents.cc/)

---

**Pro Tip:** Start by using the existing subagents as-is, then customize based on your actual development patterns. The best subagents emerge from real usage!

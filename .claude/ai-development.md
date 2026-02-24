# AI-Assisted Development Guide

## Purpose

This guide helps you work effectively with AI coding assistants (like Claude) on MeshMonitor development. It provides context, patterns, and prompts to get better results.

## Quick Context Dump for AI

When starting a new AI session, provide this context:

```
I'm working on MeshMonitor, a React + TypeScript + Node.js app for monitoring Meshtastic mesh networks.

Key tech: React 18, TypeScript, Express, SQLite (better-sqlite3), Vite
Architecture: TCP streaming protocol to Meshtastic node (port 4403), event-driven
Theme: Catppuccin Mocha (dark theme)
Testing: Vitest + Testing Library, 100% pass rate required

Current focus: [describe what you're working on]
Related files: [list relevant files]
GitHub issue: [link if applicable]
```

## Effective Prompts for Common Tasks

### Feature Implementation

**Prompt Template:**
```
I need to implement [feature name] for MeshMonitor.

Context:
- Related to [area of codebase]
- Should integrate with [existing feature]
- User story: [describe user need]

Requirements:
- [Requirement 1]
- [Requirement 2]
- Must maintain Catppuccin Mocha theme
- Needs tests (Vitest + Testing Library)

Constraints:
- [Any technical constraints]
- Must follow existing patterns in [file/folder]

Please:
1. Show implementation plan
2. Generate code with tests
3. Suggest where to add documentation
4. Write conventional commit message
```

**Example:**
```
I need to implement message search functionality for MeshMonitor.

Context:
- Messages are stored in SQLite (src/services/database.ts)
- UI is in src/components/MessageList.tsx
- User story: Users want to search through message history

Requirements:
- Full-text search on message.text
- Filter by channel, sender, date range
- Highlight search terms in results
- Must maintain Catppuccin Mocha theme
- Needs tests for search logic and UI

Constraints:
- Use SQLite FTS5 for full-text search
- Keep existing message list performance
- Must work with paginated messages

Please show implementation plan and generate code.
```

### Bug Fixes

**Prompt Template:**
```
I need to fix a bug in MeshMonitor.

Issue: [GitHub issue link or description]

Symptoms:
- [What's happening]
- [Expected behavior]
- [Steps to reproduce]

Relevant code:
- [File/function where bug likely is]

Environment:
- [Docker, dev server, specific OS/setup]

Please:
1. Analyze the root cause
2. Propose a fix
3. Generate test to prevent regression
4. Create PR description
```

**Example:**
```
I need to fix WebSocket session conflicts on Synology NAS.

Issue: https://github.com/Yeraze/meshmonitor/issues/123

Symptoms:
- Multiple clients connecting causes disconnections
- Messages drop when new client connects
- Only happens on Synology's reverse proxy

Relevant code:
- src/server/websocket.ts (connection handling)
- May involve Express session management

Environment:
- Synology NAS with built-in reverse proxy
- Multiple concurrent connections

Please analyze root cause and propose a fix with tests.
```

### Test Generation

**Prompt Template:**
```
I need comprehensive tests for [feature/file] in MeshMonitor.

Code to test: [paste code or describe file]

Test coverage needed:
- [Scenario 1]
- [Scenario 2]
- Edge cases: [list]

Testing tools: Vitest, Testing Library (for React components)

Please generate tests with:
- Descriptive test names
- Good and bad input cases
- Mock Meshtastic messages where needed
- Proper setup/teardown
```

### PR Preparation

**Prompt Template:**
```
Help me prepare a PR for MeshMonitor.

Changes made:
- [Summary of changes]
- Files modified: [list]
- Related issue: [link]

Please create:
1. PR title (conventional commits format)
2. PR description using template in .claude/pr-prep.md
3. List of what to test
4. Documentation updates needed
5. Suggested reviewers
```

### Code Review

**Prompt Template:**
```
Review this MeshMonitor code for:
- TypeScript best practices
- React patterns (hooks, state management)
- Testing coverage
- Catppuccin theme consistency
- Performance implications
- Edge cases
- Security issues

[Paste code or describe changes]

Please provide:
- Issues found (with severity)
- Specific suggestions
- Code examples for fixes
```

## Context Files to Share

When working with AI, share these for best results:

### Always Include
1. **File being modified** - Full content
2. **Related test file** - To understand test patterns
3. **Relevant type definitions** - For TypeScript context

### Sometimes Include
4. **API endpoint documentation** - For API changes
5. **Component that uses code** - For service changes
6. **Database schema** - For data model changes

### Reference These Docs
- `.claude/architecture-notes.md` - System design
- `.claude/testing-guide.md` - Test patterns
- `.claude/pr-prep.md` - PR requirements

## Iterative Development Pattern

### Step 1: Plan
```
Analyze the requirement and propose:
- Architecture changes needed
- Files to modify
- Test strategy
- Potential issues
```

### Step 2: Implement Core
```
Generate the main implementation:
- Core logic first
- Follow existing patterns
- Include TypeScript types
```

### Step 3: Add Tests
```
Generate comprehensive tests:
- Unit tests for logic
- Component tests for UI
- Integration tests for APIs
```

### Step 4: Refine
```
Review and improve:
- Error handling
- Edge cases
- Performance
- Code clarity
```

### Step 5: Document
```
Add documentation:
- JSDoc comments
- README updates
- API docs
- PR description
```

## AI Subagent Prompts

### Pre-PR Review Agent
```
You are a code reviewer for MeshMonitor. Review my changes against:

1. Testing requirements:
   - 100% tests passing
   - New features have tests
   - Following Vitest/Testing Library patterns

2. Code quality:
   - TypeScript strict mode compliance
   - No console.log/debugger
   - Follows existing patterns
   - Catppuccin theme maintained

3. Commit standards:
   - Conventional commit format
   - Clear, descriptive messages
   - Scoped appropriately

4. Documentation:
   - README updated if needed
   - API docs updated
   - Comments for complex logic

Files changed:
[paste git diff or file list]

Provide:
- Checklist of passed/failed items
- Specific issues with line numbers
- Suggestions for improvement
```

### Test Generator Agent
```
You are a test generator for MeshMonitor using Vitest and Testing Library.

Generate comprehensive tests for:
[paste code or describe functionality]

Include:
- Unit tests for pure functions
- Component tests with user interactions
- Integration tests for data flow
- Edge cases and error scenarios
- Mock data following MeshMonitor patterns

Test file location: [specify path]
Testing framework: Vitest, Testing Library
Code style: Descriptive test names, clear arrange/act/assert
```

### Documentation Agent
```
You are a technical writer for MeshMonitor.

Document this feature/change:
[describe feature]

Create/update:
- User-facing documentation (README)
- API documentation (if endpoints changed)
- Code comments (JSDoc)
- PR description

Audience: Developers and users deploying MeshMonitor
Style: Clear, concise, with examples
Format: Markdown
```

### Deployment Helper Agent
```
You are a DevOps engineer for MeshMonitor.

Help me deploy this change:
[describe change]

Consider:
- Docker image rebuild needed?
- Environment variables changed?
- Database migration required?
- Backward compatibility?
- BASE_URL subfolder implications?

Provide:
- Deployment steps
- Testing checklist
- Rollback plan
- Documentation updates
```

## Common Pitfalls to Avoid

### ❌ Don't
- Assume AI knows latest code changes
- Skip providing file context
- Ask to "make it work" without details
- Forget to mention testing requirements
- Ignore type safety for speed

### ✅ Do
- Provide full file content when asking about it
- Reference specific lines/functions
- Explain the "why" not just the "what"
- Mention MeshMonitor-specific constraints
- Ask for tests alongside code

## Debugging with AI

### Effective Debug Prompts
```
I'm getting this error in MeshMonitor:

Error message:
[paste full error with stack trace]

Context:
- What I was doing: [describe]
- Environment: [dev/Docker/production]
- Recent changes: [what changed]
- Relevant code: [paste code]

Please:
1. Identify the root cause
2. Explain why it's happening
3. Suggest a fix
4. Recommend preventive measures
```

## Multi-turn Development Pattern

For complex features, break into turns:

**Turn 1: Plan**
```
I want to add [feature]. Help me plan:
- Architecture impact
- Files to change
- Dependencies needed
- Migration strategy
```

**Turn 2: Types**
```
Based on the plan, generate TypeScript types/interfaces.
```

**Turn 3: Implementation**
```
Generate the core implementation following the types.
```

**Turn 4: Tests**
```
Generate comprehensive tests for the implementation.
```

**Turn 5: Integration**
```
Show how to integrate this into existing code.
```

**Turn 6: Finalize**
```
Review everything, create PR description, suggest documentation.
```

## Knowledge Gaps

When AI doesn't know something about MeshMonitor:

1. **Check .claude docs first** - Architecture, testing patterns
2. **Share relevant code** - Show existing patterns
3. **Link to issue** - GitHub issues have context
4. **Reference README** - Deployment, config details

## Measuring AI Effectiveness

Good AI session if:
- ✅ Code follows existing patterns
- ✅ Tests are comprehensive
- ✅ Types are correct
- ✅ Minimal manual fixes needed
- ✅ PR-ready output

Needs improvement if:
- ❌ Repeated questions about same thing
- ❌ Suggests deprecated patterns
- ❌ Ignores MeshMonitor constraints
- ❌ Missing tests or docs

## Session Template

Start each AI session with:
```
Working on MeshMonitor [feature/bug/refactor].

Context:
- Issue: [link or description]
- Goal: [what you want to achieve]
- Files involved: [list]

Constraints:
- Must maintain test coverage
- Follow Catppuccin theme
- Use conventional commits
- TypeScript strict mode

Current status:
[Where you are now]

Next steps:
[What you need help with]
```

This structured approach leads to better, more MeshMonitor-specific results.

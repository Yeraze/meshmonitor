# Development Workflow

Quick reference for testing, commits, and PR preparation.

## Testing Commands

```bash
npm run test          # Watch mode
npm run test:run      # Run once (required before PR)
npm run typecheck     # TypeScript checks
npm run lint          # ESLint
```

## Commit Workflow

**IMPORTANT**: Always show draft commit message to user before executing commit.

1. Stage relevant files
2. Draft commit message following templates below
3. **Show draft to user for approval**
4. Execute commit after approval

## Pre-PR Checklist

- [ ] All tests pass (`npm run test:run`)
- [ ] TypeScript compiles (`npm run typecheck`)
- [ ] ESLint clean (`npm run lint`)
- [ ] No console.log/debugger in code
- [ ] Code follows existing patterns
- [ ] New features have tests
- [ ] Documentation updated if needed
- [ ] Reviewed against `docs/ARCHITECTURE_LESSONS.md` if touching node communication

---

## Commit Message Format

Use conventional commits with context:

```
<type>(<scope>): <brief summary>

<body explaining WHY this change was needed>

<footer with references/breaking changes>
```

### Types
- `feat` - New feature
- `fix` - Bug fix
- `docs` - Documentation only
- `test` - Add/update tests
- `refactor` - Code restructuring (no feature change)
- `perf` - Performance improvement
- `chore` - Maintenance/tooling
- `ci` - CI/CD changes

### Intelligent Commit Examples

**Good - Provides context and reasoning:**
```
feat(message): add reply threading support

Implements reply-to functionality using replyId field in messages table.
This allows users to create conversation threads, improving message
organization in busy channels.

The UI shows a reply indicator with the original message preview.
Backend stores replyId as nullable foreign key to messages table.

Closes #234
```

**Good - Bug fix with root cause:**
```
fix(tcp): prevent memory leak in frame buffer

The frame parser was accumulating partial frames indefinitely when
receiving malformed data. Added buffer size limit (1MB) and automatic
reset after 5 minutes of inactivity.

Root cause: No cleanup logic for incomplete frames during connection
errors. This caused memory to grow unbounded over long-running sessions.

Fixes #456
```

**Good - Refactor with impact explanation:**
```
refactor(database): extract message deduplication to service

Moves duplicate detection logic from meshtasticManager to dedicated
messageService. This makes the code testable in isolation and prepares
for upcoming message filtering features.

No functional changes - existing deduplication behavior preserved.
Test coverage increased from 60% to 95% for message handling.
```

**Avoid - Too brief, no context:**
```
fix: bug fix
feat: add feature
refactor: clean up code
```

---

## Pull Request Templates

### Standard PR Template

```markdown
## Summary
Brief overview of what this PR accomplishes and why it was needed.

## Problem
What issue does this solve? What was broken or missing?
- Current behavior: [describe the problem]
- Root cause: [if applicable]

## Solution
How does this PR address the problem?
- Approach: [high-level strategy]
- Key changes: [list main modifications]

## Changes
- **Added**: New features/files
- **Modified**: Changed functionality
- **Removed**: Deleted code/features
- **Fixed**: Bug resolutions

## Testing
How was this tested?
- [ ] Unit tests added/updated
- [ ] Integration tests pass
- [ ] Manually tested scenarios:
  - Scenario 1: [describe]
  - Scenario 2: [describe]

## Impact
What could this affect?
- **User-facing**: [any UI/UX changes]
- **API**: [any endpoint changes]
- **Database**: [any schema changes]
- **Performance**: [any perf impacts]
- **Breaking changes**: [if any, describe migration path]

## Screenshots
_If UI changes, include before/after screenshots_

## Related Issues
Fixes #123
Relates to #456
Addresses feedback from #789

## Checklist
- [ ] Tests pass
- [ ] TypeScript compiles
- [ ] ESLint clean
- [ ] Documentation updated
- [ ] Reviewed against ARCHITECTURE_LESSONS.md (if touching async/state)
- [ ] No Catppuccin theme color changes
```

### Quick PR Template (Minor Changes)

```markdown
## Summary
Brief description of the change.

## Changes
- Change 1
- Change 2

## Testing
- [ ] Tests pass
- [ ] Manually verified

Fixes #123
```

---

## Issue Templates

### Bug Report

```markdown
## Description
Clear, concise description of the bug.

## Expected Behavior
What should happen?

## Actual Behavior
What actually happens?

## Steps to Reproduce
1. Go to '...'
2. Click on '...'
3. See error

## Environment
- MeshMonitor version: [e.g., 2.19.3]
- Deployment: [Docker/npm/Kubernetes]
- Node.js version: [if npm]
- Browser: [if UI issue]
- Meshtastic firmware: [if connection issue]

## Logs
```
Paste relevant logs here
```

## Additional Context
- Started happening after: [if known]
- Workaround: [if found]
- Related issues: [if any]
```

### Feature Request

```markdown
## Problem
What problem does this feature solve?
Describe the use case and current workaround (if any).

## Proposed Solution
How should this work?
- User flow: [describe interaction]
- Technical approach: [if you have ideas]

## Alternatives Considered
What other approaches did you think about?
- Alternative 1: [pros/cons]
- Alternative 2: [pros/cons]

## Impact
Who benefits from this?
- Typical users? Power users? Developers?
- Estimated frequency of use?

## Additional Context
- Related features: [if any]
- Similar implementations: [other projects doing this]
- Screenshots/mockups: [if helpful]
```

---

## Test Types

**Unit Tests** - Individual functions/utilities
- Focus: Single responsibility
- Speed: Fast (milliseconds)
- Example: Parsing functions, validators

**Component Tests** - React components with user interactions
- Focus: User behavior
- Speed: Medium (seconds)
- Example: Message bubble rendering, button clicks

**Integration Tests** - API endpoints and data flow
- Focus: System interactions
- Speed: Slower (seconds to minutes)
- Example: Full message send/receive cycle

---

## Common Test Patterns

### Unit Test
```typescript
import { describe, it, expect } from 'vitest';
import { parseNodeId } from './nodeHelpers';

describe('parseNodeId', () => {
  it('converts decimal node number to hex ID', () => {
    expect(parseNodeId(305419896)).toBe('!12345678');
  });

  it('handles edge cases gracefully', () => {
    expect(parseNodeId(0)).toBe('!00000000');
    expect(() => parseNodeId(-1)).toThrow('Invalid node ID');
  });
});
```

### Component Test
```typescript
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import MessageBubble from './MessageBubble';

describe('MessageBubble', () => {
  it('displays message with sender name and timestamp', () => {
    render(<MessageBubble
      text="Hello mesh!"
      from="Alice"
      timestamp={new Date('2024-01-15T10:30:00Z')}
    />);

    expect(screen.getByText('Hello mesh!')).toBeInTheDocument();
    expect(screen.getByText('Alice')).toBeInTheDocument();
    expect(screen.getByText(/10:30/)).toBeInTheDocument();
  });

  it('allows reply when reply button clicked', () => {
    const handleReply = vi.fn();
    render(<MessageBubble text="Test" onReply={handleReply} />);

    fireEvent.click(screen.getByRole('button', { name: /reply/i }));
    expect(handleReply).toHaveBeenCalledTimes(1);
  });
});
```

---

## Docker Testing

Test in container before PR:

```bash
# Build with current code
docker-compose -f docker-compose.dev.yml build

# Start and verify functionality
docker-compose -f docker-compose.dev.yml up

# Check logs for errors
docker-compose -f docker-compose.dev.yml logs -f

# Cleanup when done
docker-compose -f docker-compose.dev.yml down -v
```

---

## Debugging Tips

**Backend (Express)**:
- VS Code debugger with breakpoints
- Add `console.log` temporarily (remove before PR)
- Check `src/server/meshtasticManager.ts` for connection issues

**Frontend (React)**:
- Browser DevTools (Chrome/Firefox)
- React DevTools extension
- Vite preserves source maps for debugging

**Tests**:
- `npm run test:ui` for visual debugging
- `console.log` in tests to inspect values
- `.only()` to run single test: `it.only('specific test', ...)`

---

## CI/CD Pipeline

Tests run automatically on:
- Every pull request
- Merges to main
- Node.js versions: 20.x, 22.x

**All tests must pass before merge.**

---

## Quick Reference

### Test Naming
```typescript
// Good - Describes expected behavior
it('should retry connection with exponential backoff after disconnect')

// Avoid - Too vague
it('works')
it('test connection')
```

### File Organization
```
Feature implementation → src/
Feature tests → src/ (same directory, .test.ts suffix)
Integration tests → tests/
```

### Coverage Requirement
100% **passing** tests (not 100% coverage %)

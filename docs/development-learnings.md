# Development Learnings & Best Practices

This document captures key learnings, best practices, and lessons learned from development sessions to improve future work.

**Last Updated**: October 3, 2025

---

## 🎓 Technical Insights

### Git Submodules in Docker/CI Environments

**Problem**: Git submodules don't automatically get included when checking out code in CI/CD pipelines.

**Learnings**:
- GitHub Actions requires explicit `submodules: recursive` in checkout steps
- Source tarballs from GitHub releases don't include submodule contents
- Docker builds should validate critical dependencies early (fail fast pattern)

**Best Practice**:
```yaml
# Always use this for repos with submodules
- uses: actions/checkout@v4
  with:
    submodules: recursive
```

**Validation in Dockerfile**:
```dockerfile
# Fail fast with helpful error message
RUN if [ ! -f "critical/dependency/file" ]; then \
      echo "ERROR: Dependency not found! Check submodules."; \
      exit 1; \
    fi
```

**Reference**: Fixed in [#88](https://github.com/Yeraze/meshmonitor/pull/88) (v1.11.2)

---

### React Component Design

**Problem**: Code duplication across components, missing edge case handling.

**Learnings**:
1. **Code duplication is a code smell** - If you copy-paste component logic, extract it
2. **Edge cases should be handled from the start** - Don't assume data is always valid
3. **Small, focused components are more maintainable** - Single responsibility principle

**Best Practice**:
```tsx
// ✅ Good: Reusable component with edge case handling
interface Props {
  value?: number;
  otherValue?: number;
}

const MyComponent: React.FC<Props> = ({ value, otherValue }) => {
  // Guard against undefined
  if (value === undefined || otherValue === undefined) {
    return null;
  }

  const result = value - otherValue;

  // Guard against invalid calculated values
  if (result < 0) {
    return null;
  }

  return <span>{result}</span>;
};

// ❌ Bad: Inline logic duplicated in multiple places
{msg.hopStart !== undefined && msg.hopLimit !== undefined && (
  <span>{msg.hopStart - msg.hopLimit}</span>
)}
```

**Reference**: Refactored in [#84](https://github.com/Yeraze/meshmonitor/pull/84) - HopCountDisplay component

---

### Map Icon Rendering with Leaflet

**Learnings**:
- **divIcon with inline SVG** provides maximum flexibility and performance
- **Dynamic icon generation** allows data-driven styling (color by hop count, size by selection state)
- **Zoom-level based features** enhance UX without cluttering at low zoom
- **Color gradients** communicate network topology effectively

**Best Practice**:
```tsx
// Dynamic icon generation based on data
const createIcon = (data: NodeData, zoom: number) => {
  const color = getColorFromData(data);
  const size = data.isSelected ? 60 : 48;
  const showLabel = zoom >= 13;

  return L.divIcon({
    html: `
      <div style="position: relative;">
        <svg><!-- SVG content --></svg>
        ${showLabel ? `<div class="label">${data.name}</div>` : ''}
      </div>
    `,
    className: 'custom-icon',
    iconSize: [size, size],
    iconAnchor: [size / 2, size]
  });
};
```

**Reference**: Implemented in [#85](https://github.com/Yeraze/meshmonitor/pull/85) (v1.12.0)

---

## ✅ What Works Well

### 1. Iterative Development with Code Review

**Process**:
1. Implement basic feature
2. Create PR and get code review feedback
3. Refactor based on feedback
4. Result: cleaner, more robust code

**Example**: PR #84 hop count display
- Initial: Duplicated inline logic
- Feedback: Extract to component, handle edge cases
- Result: Reusable HopCountDisplay component with validation

### 2. TodoWrite Tool for Task Management

**Benefits**:
- Tracks multi-step tasks systematically
- Keeps development organized through complex workflows
- Makes progress visible
- Helps ensure nothing is forgotten

**Best Practice**:
```javascript
// Start complex tasks with a todo list
TodoWrite([
  { content: "Analyze problem", status: "in_progress", activeForm: "..." },
  { content: "Implement solution", status: "pending", activeForm: "..." },
  { content: "Test changes", status: "pending", activeForm: "..." },
  { content: "Update documentation", status: "pending", activeForm: "..." }
]);

// Update as you progress
// Mark completed IMMEDIATELY after finishing each task
```

### 3. Rapid Bug Response Workflow

**Process demonstrated in Issue #86**:
1. User reports issue
2. Quickly identify root cause
3. Fix comprehensively (all affected areas)
4. Update documentation
5. Release bug fix version
6. Close issue with detailed resolution

**Timeline**: Same session from report to release!

### 4. Comprehensive Documentation

**Always update**:
- ✅ README with setup instructions
- ✅ Helpful error messages in code
- ✅ Comprehensive release notes
- ✅ Issue comments with resolution details

---

## ❌ What Didn't Work Well

### 1. Test Environment Issues

**Problem**: Created component tests but had jsdom environment issues, ended up removing tests.

**What went wrong**:
- Didn't ensure test environment was properly configured
- Gave up on tests instead of fixing the setup
- Left codebase without test coverage for new component

**Solution for next time**:
```typescript
// Ensure proper test setup
// vitest.config.ts
export default defineConfig({
  test: {
    environment: 'jsdom',
    setupFiles: './src/test/setup.ts',
  }
});

// Component test file
// @vitest-environment jsdom
import { render } from '@testing-library/react';
import MyComponent from './MyComponent';

describe('MyComponent', () => {
  it('renders correctly', () => {
    const { container } = render(<MyComponent />);
    expect(container).toMatchSnapshot();
  });
});
```

**Action**: Fix test environment configuration before starting component development.

### 2. Initial Code Quality

**Problem**: First implementation had duplicated code that should have been a component from the start.

**What went wrong**:
- Didn't think about reusability upfront
- Copy-pasted logic to second location
- Had to refactor later based on code review

**Solution for next time**:
- **Before writing code**: Ask "Will this logic be used in multiple places?"
- **If yes**: Extract to reusable component/function immediately
- **Code review mindset**: Review your own code before committing

### 3. Version Number Management

**Problem**:
- PR #84 was v1.11.1
- PR #85 was v1.12.0 (feature release)
- Merging #84 after #85 caused version conflicts
- Confusion between 1.11.1, 1.12.0, 1.12.1

**What went wrong**:
- Multiple PRs in flight with different version increments
- Didn't coordinate version numbers upfront
- Merge conflicts in package.json

**Solution for next time**:
```markdown
## Version Strategy

1. **Plan versions before creating PRs**
   - Agree on next version number
   - Document in PR title

2. **Version increment rules**
   - Major (x.0.0): Breaking changes
   - Minor (1.x.0): New features
   - Patch (1.1.x): Bug fixes

3. **Multiple PRs**
   - Stack patches on same minor version
   - If feature PR exists, coordinate next minor version
   - Merge features first, then patches

4. **Release branches**
   - Consider release/v1.x.x branches for complex releases
```

### 4. Merge Conflict Resolution

**Problem**: Had to force push an amended commit to fix version number.

**What went wrong**:
- Feature branch got stale relative to main
- Manual merge conflict resolution
- Force push required (not ideal)

**Solution for next time**:
```bash
# Merge main into feature branch regularly
git checkout feature-branch
git merge main
# Resolve conflicts
git push

# OR use rebase for cleaner history (before creating PR)
git checkout feature-branch
git rebase main
# Resolve conflicts
git push --force-with-lease
```

---

## 🚀 Process Improvements

### 1. Test-Driven Development

**Current problem**: Tests are an afterthought, sometimes skipped.

**Improvement**:
```markdown
1. Write test first (red)
2. Implement minimum code to pass (green)
3. Refactor (refactor)
4. Commit

This ensures:
- Test coverage from the start
- Tests actually work
- Edge cases are considered
```

### 2. Code Review Checklist

**Before creating PR**:
- [ ] Self-review code for duplication
- [ ] Check for edge cases (null, undefined, negative values)
- [ ] Add tests for new functionality
- [ ] Update documentation
- [ ] Type check passes (`npm run typecheck`)
- [ ] All tests pass (`npm run test:run`)
- [ ] Consider reusability - could this be a component/utility?

### 3. Branch Management

**Best practices**:
- Merge main into feature branches every day
- Delete merged branches immediately
- Keep feature branches short-lived (< 3 days)
- Rebase before final PR (for clean history)

### 4. Version Planning

**Before starting work**:
- Check existing open PRs
- Coordinate version numbers
- Document in issue/PR
- Update package.json early in branch

---

## 💡 Best Practices Reinforced

### Early Validation (Fail Fast)

```dockerfile
# Validate dependencies at build time
RUN if [ ! -f "required-file" ]; then \
      echo "ERROR: Missing dependency"; \
      echo "How to fix: <clear instructions>"; \
      exit 1; \
    fi
```

### Clear Error Messages

```typescript
// ❌ Bad
throw new Error('Invalid');

// ✅ Good
throw new Error(
  'Invalid hop count: hopStart (${hopStart}) - hopLimit (${hopLimit}) = ${result}. ' +
  'Expected positive value. This may indicate malformed mesh packet data.'
);
```

### Documentation as Code

- README changes are as important as code changes
- Keep docs in sync with implementation
- Add examples for complex features
- Document known issues and workarounds

### Comprehensive Bug Fixes

When fixing a bug:
1. ✅ Fix the immediate issue
2. ✅ Find all similar occurrences
3. ✅ Update all affected areas
4. ✅ Add validation to prevent recurrence
5. ✅ Update documentation
6. ✅ Add tests for the bug

**Example**: Issue #86 fixed in:
- docker-publish.yml
- release.yml
- ci.yml
- Dockerfile validation
- README documentation

---

## 📋 Quick Reference Checklists

### Starting a New Feature

- [ ] Create feature branch from latest main
- [ ] Plan version number (coordinate with other PRs)
- [ ] Write tests first (TDD)
- [ ] Implement feature
- [ ] Self code review (check for duplication, edge cases)
- [ ] Update documentation
- [ ] Run type check and tests
- [ ] Create PR with clear description

### Fixing a Bug

- [ ] Reproduce the issue
- [ ] Identify root cause
- [ ] Write test that fails (proves bug)
- [ ] Fix the issue
- [ ] Verify test passes
- [ ] Check for similar issues elsewhere
- [ ] Update documentation
- [ ] Add validation to prevent recurrence
- [ ] Create PR linking to issue

### Merging PRs

- [ ] Ensure CI passes
- [ ] Review code changes
- [ ] Check for version conflicts
- [ ] Verify documentation updates
- [ ] Merge
- [ ] Delete branch
- [ ] Pull main locally
- [ ] Consider release if appropriate

### Creating a Release

- [ ] Ensure all PRs are merged
- [ ] Verify version in package.json
- [ ] Create git tag (let GitHub create it)
- [ ] Write comprehensive release notes
- [ ] Include "What's New", "Fixed", "Breaking Changes"
- [ ] Link to PRs and issues
- [ ] Include upgrade instructions if needed

---

## 🎯 Key Takeaways

1. **Responsive development works** - Quick response to issues and feedback leads to better software
2. **Test environment matters** - Don't skip tests due to configuration issues, fix the environment
3. **Think before coding** - Consider reusability, edge cases, and testing upfront
4. **Document everything** - Future you (and others) will thank you
5. **Fix comprehensively** - Don't just patch the symptom, fix all related areas
6. **Version management is important** - Plan it, don't let it be an afterthought

---

## 📚 Session References

- **v1.11.1** ([#84](https://github.com/Yeraze/meshmonitor/pull/84)) - Hop count display with component refactoring
- **v1.12.0** ([#85](https://github.com/Yeraze/meshmonitor/pull/85)) - Enhanced map icons with hop-based coloring
- **v1.11.2** ([#88](https://github.com/Yeraze/meshmonitor/pull/88)) - Protobuf submodule Docker fix
- **Issue #86** - Docker build missing protobufs (resolved in v1.11.2)

---

*This document should be updated after significant development sessions to capture new learnings and refine best practices.*

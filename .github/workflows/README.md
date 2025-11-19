# GitHub Actions Configuration

## Claude Code Review

The `claude-code-review.yml` workflow provides automated code review using Claude AI.

### Security & Access Control

**Important**: This workflow only runs for **trusted contributors** to prevent API quota abuse:

- ✅ **OWNER**: Repository owner
- ✅ **MEMBER**: Organization members
- ✅ **COLLABORATOR**: Repository collaborators
- ❌ **FIRST_TIME_CONTRIBUTOR**: Will NOT run automatically

For first-time contributors, maintainers can manually trigger the workflow after reviewing the PR.

### Authentication Setup

You need to configure **one** of the following authentication methods:

#### Option 1: Claude Code OAuth Token (Recommended for Claude Pro/Max users)

1. Run `claude setup-token` in your local Claude Code terminal
2. Copy the generated token
3. Add it to GitHub repository secrets:
   - Go to: Settings → Secrets and variables → Actions → New repository secret
   - Name: `CLAUDE_CODE_OAUTH_TOKEN`
   - Value: [paste your token]

#### Option 2: Anthropic API Key

1. Get your API key from https://console.anthropic.com/
2. Add it to GitHub repository secrets:
   - Go to: Settings → Secrets and variables → Actions → New repository secret
   - Name: `ANTHROPIC_API_KEY`
   - Value: [paste your API key]

### How It Works

1. **Trigger**: Runs on every PR open/update from trusted contributors
2. **Review**: Claude analyzes the code changes and provides feedback on:
   - Code quality and best practices
   - Potential bugs or issues
   - Performance considerations
   - Security concerns
   - Test coverage
3. **Comment**: Posts review feedback directly on the PR

### Customization

You can customize the review prompt in the workflow file:

```yaml
direct_prompt: |
  Please review this pull request and provide feedback on:
  - Code quality and best practices
  - Potential bugs or issues
  - Performance considerations
  - Security concerns
  - Test coverage
```

### Troubleshooting

**Workflow doesn't run:**
- Check if the PR author is a trusted contributor (OWNER, MEMBER, or COLLABORATOR)
- Maintainers can manually re-run the workflow from the Actions tab

**Authentication errors:**
- Ensure either `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY` is set in repository secrets
- Verify the token/key hasn't expired
- Check the workflow run logs for specific error messages

**For first-time contributors:**
- The workflow is intentionally skipped for security
- Maintainers should review the PR manually first
- After approving, maintainers can add the contributor as a collaborator or manually trigger the workflow

### Best Practices

- 🔒 **Never commit credentials** to the repository
- 🔄 **Rotate tokens regularly** for security
- 📝 **Review Claude's suggestions** - they're helpful but not infallible
- 🎯 **Customize prompts** based on your project's specific needs

### Cost Considerations

- Each PR review consumes API credits
- Consider limiting to specific file types or PR sizes if needed
- Monitor usage in your Anthropic console or Claude Code dashboard

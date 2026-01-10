# External PR Security Setup

This document explains how DRS protects against cost abuse and security risks from external pull requests.

## Overview

DRS implements a multi-layered security approach for external PR reviews:

1. **Automatic reviews** for repository members and collaborators
2. **Manual approval required** for first-time and external contributors
3. **Label-based review triggers** for maintainer control
4. **GitHub Environment protection** with required reviewers

## How It Works

### For Trusted Contributors (Repository Members/Collaborators)

When a PR is opened by someone with write access to the repository:
- ✅ Automated review runs immediately
- ✅ No manual approval needed
- ✅ Full access to all review features

### For External Contributors

When a PR is opened by someone without repository access:
- ⏸️  Automated review is paused
- 📝 A notification comment is posted on the PR
- 🔒 Maintainer approval is required to proceed

**Maintainers have two options to approve:**

1. **Add the `safe-to-review` label** (Quick method)
   - Go to the PR page
   - Add the `safe-to-review` label
   - Review will start automatically

2. **Approve the environment** (Environment protection method)
   - Go to the Actions tab
   - Find the waiting workflow
   - Approve the environment deployment

## Setup Instructions

### Step 1: Create the GitHub Environment

1. Go to your repository **Settings** → **Environments**
2. Click **New environment**
3. Name it: `external-pr-review`
4. Click **Configure environment**

### Step 2: Configure Environment Protection Rules

Add the following protection rules:

#### Required Reviewers
1. Under **Environment protection rules**, check **Required reviewers**
2. Add trusted maintainers who should approve external PRs
3. You can add up to 6 reviewers
4. At least 1 reviewer must approve before the workflow runs

#### Optional: Deployment Branches
1. Under **Deployment branches**, select **Protected branches only** if you want to restrict reviews to PRs targeting specific branches
2. Or select **All branches** to allow reviews on any target branch

#### Optional: Wait Timer
1. Add a **Wait timer** if you want a cooling-off period before reviews can run
2. Recommended: 0 minutes (no delay once approved)

### Step 3: Create the `safe-to-review` Label

1. Go to your repository **Issues** → **Labels**
2. Click **New label**
3. Set:
   - **Name**: `safe-to-review`
   - **Description**: `Approved for automated review (external PRs)`
   - **Color**: `#0E8A16` (green) or your preference
4. Click **Create label**

## Workflow Behavior

### Workflow Triggers

The PR review workflow triggers on:
- `pull_request_target`: When PRs are opened, synchronized, or reopened
- `pull_request`: When labels are added (to detect `safe-to-review` label)

### Security Features

#### 1. Contributor Verification
```yaml
verify-contributor:
  - Checks if PR author is a repository collaborator
  - Sets outputs: is-trusted, has-review-label
```

#### 2. Conditional Execution
- **review-trusted**: Runs only for trusted contributors (no approval needed)
- **review-external**: Runs only for external contributors WITH `safe-to-review` label
- **notify-external**: Posts instructions for external PRs without approval

#### 3. Safe Code Checkout
```yaml
# Uses specific PR commit SHA (not branch ref)
ref: ${{ github.event.pull_request.head.sha }}
```

This prevents attackers from modifying code after approval.

## Cost Protection

### Prevents Cost Abuse By:
1. **Blocking automatic execution** for external PRs
2. **Requiring explicit approval** from maintainers
3. **Label-based gating** prevents spam PR attacks
4. **One-time approval per PR** (not per commit)

### Rate Limiting
- External PRs cannot trigger reviews without approval
- Maintainers control when reviews run
- No API calls made until approved

## Security Considerations

### Why `pull_request_target`?

The workflow uses `pull_request_target` instead of `pull_request` because:

✅ **Advantages:**
- Access to repository secrets (required for OpenCode API keys)
- Can post comments on external PRs
- Runs in the context of the base branch (trusted code)

⚠️ **Safety Measures:**
- Only checks out PR code AFTER approval verification
- Uses specific commit SHA (not branch ref)
- Minimal permissions (`contents: read`, `pull-requests: write`)
- No arbitrary code execution from PR before approval

### Attack Scenarios Prevented

| Attack Vector | Protection |
|--------------|------------|
| **Spam PRs to drain API credits** | ✅ Requires maintainer approval |
| **Malicious code execution** | ✅ Only trusted code runs before approval |
| **Secret exfiltration** | ✅ Secrets only available after approval |
| **API key abuse** | ✅ No API calls without approval |
| **Workflow manipulation** | ✅ Workflow runs from base branch |

## Maintainer Workflow

### Reviewing External PRs

1. **External contributor opens PR**
   ```
   → verify-contributor job runs
   → notify-external posts comment
   → Workflow pauses
   ```

2. **Maintainer reviews PR code manually**
   ```bash
   # Review the PR diff in GitHub UI
   # Check for suspicious changes
   # Verify it's a legitimate contribution
   ```

3. **Maintainer approves review**
   ```
   Option A: Add 'safe-to-review' label
   Option B: Approve environment in Actions tab
   ```

4. **Automated review runs**
   ```
   → review-external job executes
   → OpenCode analyzes changes
   → Posts review comments
   ```

### Best Practices

1. **Always review external PR code before approving**
   - Check for malicious code
   - Verify it's a legitimate contribution
   - Look for suspicious patterns

2. **Use the `safe-to-review` label for quick approvals**
   - Faster than environment approval
   - Can be automated with GitHub Actions if needed

3. **Monitor API usage**
   - Check your OpenCode/Anthropic API usage dashboard
   - Set up billing alerts
   - Review costs regularly

4. **Revoke approval if PR changes**
   - If external contributor pushes new commits after approval
   - Remove the `safe-to-review` label to re-review
   - Re-add label after reviewing new changes

## Configuration Options

### Customize Trusted Contributors

Edit `.github/workflows/pr-review.yml` line 31 to customize who is trusted:

```yaml
# Current: Checks if user is a collaborator
if gh api "/repos/$REPO/collaborators/$AUTHOR" --silent 2>/dev/null; then

# Alternative: Check organization membership
if gh api "/orgs/YOUR_ORG/members/$AUTHOR" --silent 2>/dev/null; then

# Alternative: Check team membership
if gh api "/orgs/YOUR_ORG/teams/YOUR_TEAM/memberships/$AUTHOR" --silent 2>/dev/null; then
```

### Customize Environment Name

Change the environment name in line 118:

```yaml
environment: external-pr-review  # Change this to your preferred name
```

Then create an environment with the matching name in GitHub Settings.

### Disable External PR Reviews

If you want to completely disable reviews for external contributors:

```yaml
# Comment out or remove the review-external job
# review-external:
#   runs-on: ubuntu-latest
#   ...
```

## Troubleshooting

### External PR review not running after adding label

**Cause**: The `pull_request` event might not trigger for label additions.

**Solution**:
1. Remove and re-add the `safe-to-review` label
2. Or close and reopen the PR
3. Or push a new commit to the PR branch

### Environment approval not showing

**Cause**: Environment not configured in repository settings.

**Solution**:
1. Go to Settings → Environments
2. Create `external-pr-review` environment
3. Add required reviewers

### Trusted contributor not auto-reviewing

**Cause**: User might not be a repository collaborator.

**Solution**:
1. Go to Settings → Collaborators
2. Add the user as a collaborator
3. Or add them to a team with write access

### Workflow runs but secrets are not available

**Cause**: Secrets are not configured in repository settings.

**Solution**:
1. Go to Settings → Secrets and variables → Actions
2. Add required secrets:
   - `OPENCODE_ZEN_API_KEY`
   - `ANTHROPIC_API_KEY` (if using Anthropic)
3. Ensure secrets are available to the `external-pr-review` environment

## Additional Security Recommendations

1. **Enable branch protection** on main branches
   - Require PR reviews before merging
   - Require status checks to pass
   - Include administrators in restrictions

2. **Audit external contributions regularly**
   - Review who's contributing to your project
   - Check for unusual patterns
   - Monitor API usage spikes

3. **Set up billing alerts**
   - Configure alerts in your OpenCode/Anthropic dashboard
   - Set reasonable monthly limits
   - Monitor costs weekly

4. **Use environment secrets** for sensitive keys
   - Store API keys in environment-specific secrets
   - Limit access to specific workflows
   - Rotate keys regularly

## Support

For questions or issues with external PR security:

1. Check the [GitHub Actions Integration Guide](./GITHUB_ACTIONS_INTEGRATION.md)
2. Review GitHub's [Environment protection rules](https://docs.github.com/en/actions/deployment/targeting-different-environments/using-environments-for-deployment#environment-protection-rules)
3. Open an issue in the DRS repository

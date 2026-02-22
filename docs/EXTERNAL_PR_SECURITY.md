# External PR Security

This guide covers safe operation of DRS for pull requests from external contributors.

## Recommended Controls

1. **Require manual approval** before running review jobs on forked PRs.
2. **Use environment protection rules** for workflows that access paid model API keys.
3. **Limit token permissions** (`contents: read`, `pull-requests: write` only when needed).
4. **Rate-limit or label-gate execution** to avoid API-cost abuse.
5. **Monitor provider usage dashboards** for unusual spikes.

## Secrets Handling

- Store provider keys in GitHub/GitLab encrypted secrets.
- Never print secrets in workflow logs.
- Rotate keys if suspicious activity is detected.

## Suggested Workflow Pattern

- Auto-run DRS for trusted contributors.
- For external contributors, require maintainer approval/label first.
- Post comments only after workflow is approved.

## Incident Response

If abuse is suspected:

1. Disable the review workflow.
2. Rotate provider/API tokens.
3. Audit recent workflow runs and repository events.
4. Re-enable with stricter gating.

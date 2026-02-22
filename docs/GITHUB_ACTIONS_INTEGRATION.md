# GitHub Actions Integration (Pi Runtime)

Use DRS to review pull requests in GitHub Actions.

## Example Workflow

```yaml
name: PR Review

on:
  pull_request:
    types: [opened, synchronize, reopened]

jobs:
  review:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - run: npm install -g @diff-review-system/drs
      - run: drs review-pr --owner "${{ github.repository_owner }}" --repo "${{ github.event.repository.name }}" --pr "${{ github.event.pull_request.number }}" --post-comments
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
```

## Optional Runtime Endpoint

DRS defaults to in-process Pi runtime.

```yaml
env:
  PI_SERVER: http://pi-runtime.internal:3000
  # Legacy alias still accepted:
  # OPENCODE_SERVER: http://pi-runtime.internal:3000
```

## Recommended Security Controls

- Use repository environment protection for external contributors.
- Restrict write permissions where possible.
- Require manual approval for forked PR workflows that consume paid model APIs.

## Required Secrets

Set one provider API key:

- `ANTHROPIC_API_KEY`
- `OPENAI_API_KEY`
- `ZHIPU_API_KEY`
- or another supported provider key

## Troubleshooting

- **No comments posted**: ensure `pull-requests: write` permission.
- **Model/provider errors**: check API key and model config.
- **Runtime connectivity errors**: unset `PI_SERVER` to verify in-process fallback.

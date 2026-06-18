# GitHub Actions Integration (Pi Runtime)

Use DRS to review pull requests in GitHub Actions.

## Example Workflow

Pi runtime is bundled with DRS — `npm install -g @diff-review-system/drs` is all you need.

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
          node-version: '22.19.0'
      - run: npm install -g @diff-review-system/drs
      - run: drs workflow run github-pr-review --input owner="${{ github.repository_owner }}" --input repo="${{ github.event.repository.name }}" --input pr="${{ github.event.pull_request.number }}" --input describe=true --input post=true
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
```

## Runtime Mode

DRS uses Pi in-process runtime only. No runtime endpoint environment variables are required.

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
- **Runtime connectivity errors**: DRS runs in-process, so verify provider API credentials and local execution environment.

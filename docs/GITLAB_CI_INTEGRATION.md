# GitLab CI Integration (Pi Runtime)

This guide shows how to run DRS in GitLab CI using the Pi runtime.

## Minimal Pipeline

```yaml
stages:
  - review

ai_review:
  stage: review
  image: node:20-alpine
  script:
    - npm install -g @diff-review-system/drs
    - drs review-mr --project "$CI_PROJECT_PATH" --mr "$CI_MERGE_REQUEST_IID" --post-comments
  variables:
    GITLAB_TOKEN: "$CI_JOB_TOKEN"
    GITLAB_URL: "$CI_SERVER_URL"
    ANTHROPIC_API_KEY: "$ANTHROPIC_API_KEY"
  only:
    - merge_requests
  allow_failure: true
```

## Runtime Mode

DRS uses Pi in-process runtime only. No external runtime endpoint variables are required.

## Optional Code Quality Report

```yaml
script:
  - drs review-mr --project "$CI_PROJECT_PATH" --mr "$CI_MERGE_REQUEST_IID" \
      --code-quality-report gl-code-quality-report.json
artifacts:
  reports:
    codequality: gl-code-quality-report.json
```

## Required Secrets

Set one model provider API key in GitLab CI/CD variables (masked/protected):

- `ANTHROPIC_API_KEY`
- `OPENAI_API_KEY`
- `ZHIPU_API_KEY`
- or another supported provider key

## Troubleshooting

- **Auth errors**: verify `GITLAB_TOKEN` and provider API key.
- **No output/comments**: re-run with `--debug`.
- **Model not found**: verify `review.default.model` and any per-agent overrides.

# GitLab CI Integration (Pi Runtime)

This guide shows how to run DRS in GitLab CI using the Pi runtime.

## Minimal Pipeline

Pi runtime is bundled with DRS — `npm install -g @diff-review-system/drs` is all you need.

```yaml
stages:
  - review

ai_review:
  stage: review
  image: node:22.19.0-alpine
  script:
    - npm install -g @diff-review-system/drs
    - drs workflow run gitlab-mr-review --input project="$CI_PROJECT_PATH" --input mr="$CI_MERGE_REQUEST_IID" --input describe=true --input post=true
  variables:
    GITLAB_TOKEN: "$CI_JOB_TOKEN"
    GITLAB_URL: "$CI_SERVER_URL"
    ANTHROPIC_API_KEY: "$ANTHROPIC_API_KEY"
  only:
    - merge_requests
  allow_failure: true
```

## Optional Jev mode

Store `JEV_API_KEY` as a masked, protected, and preferably environment-scoped GitLab CI/CD
variable. Provide it only to a trusted generation job whose rules match the intended protected
branch/environment boundary:

```yaml
jev_review:
  stage: review
  image: node:22.19.0-alpine
  script:
    - npm install -g @diff-review-system/drs
    - drs workflow run gitlab-mr-review --input project="$CI_PROJECT_PATH" --input mr="$CI_MERGE_REQUEST_IID" --input reviewMode=parallel
  variables:
    GITLAB_TOKEN: "$CI_JOB_TOKEN"
    ANTHROPIC_API_KEY: "$ANTHROPIC_API_KEY"
    JEV_API_KEY: "$JEV_API_KEY"
```

Jev sends focused diff/task/context data to TypeSafe's remote API. Do not expose the key to
untrusted merge-request code or deterministic posting-only jobs. See
[Jev quality evaluation](JEV_INTEGRATION.md).

## Runtime Mode

DRS uses Pi in-process runtime only. No external runtime endpoint variables are required.

## Optional Code Quality Report

Enable Code Quality output when you want GitLab Code Quality artifacts:

```yaml
ai_review_code_quality:
  stage: review
  image: node:22.19.0-alpine
  script:
    - npm install -g @diff-review-system/drs
    - drs workflow run gitlab-mr-review --input project="$CI_PROJECT_PATH" --input mr="$CI_MERGE_REQUEST_IID" --input codeQuality=true
  artifacts:
    reports:
      codequality: gl-code-quality-report.json
    when: always
    expire_in: 1 week
  only:
    - merge_requests
```

## Required Secrets

Set one model provider API key in GitLab CI/CD variables (masked/protected):

- `ANTHROPIC_API_KEY`
- `OPENAI_API_KEY`
- `ZHIPU_API_KEY`
- or another supported provider key

For `jev`, `parallel`, or `combined` mode, also set `JEV_API_KEY` as a masked/protected variable. It is not
needed in the default `agent` mode.

## Troubleshooting

- **Auth errors**: verify `GITLAB_TOKEN` and provider API key.
- **No output/comments**: re-run with `drs workflow run ... --debug`.
- **Model not found**: verify `agents.default.model` and any per-agent overrides.

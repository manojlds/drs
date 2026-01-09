# GitLab CI Integration Guide

This guide explains different strategies for integrating DRS AI code reviews into your GitLab CI pipeline.

## Quick Start

### 1. Set Up CI/CD Variables

Go to your GitLab project: **Settings → CI/CD → Variables**

Add the following variable:
- `ANTHROPIC_API_KEY`: Your Anthropic API key for Claude AI
  - Type: Variable
  - Protected: Yes (recommended)
  - Masked: Yes (recommended)

### 2. Add to Your `.gitlab-ci.yml`

```yaml
include:
  - remote: 'https://raw.githubusercontent.com/manojlds/drs/main/src/ci/gitlab-ci.template.yml'

ai_review:
  extends: .drs_review
  stage: review
```

That's it! AI reviews will now run on every merge request.

## Docker Container

**The template uses the official OpenCode container: `ghcr.io/anomalyco/opencode:latest`**

Benefits:
- ✅ OpenCode CLI pre-installed (no need to install separately)
- ✅ Faster pipeline execution (no npm install of opencode-ai)
- ✅ Consistent environment
- ✅ Smaller download size vs installing Node + OpenCode separately

This container includes:
- Node.js 20+
- opencode CLI
- npm and basic build tools

## Integration Strategies

### Strategy 1: Simple Parallel Stages (Recommended)

**Use case**: You want AI reviews to run alongside your tests but not block deployment.

**File**: `examples/.gitlab-ci.yml`

```yaml
stages:
  - review    # Runs in parallel with test
  - test
  - build
  - deploy

include:
  - remote: 'https://raw.githubusercontent.com/manojlds/drs/main/src/ci/gitlab-ci.template.yml'

ai_review:
  extends: .drs_review
  stage: review
  allow_failure: true  # Won't block pipeline

test:
  stage: test
  script: npm test
  # Runs in parallel with AI review

build:
  stage: build
  script: npm run build
  needs: ["test"]  # Only waits for tests, not AI review
```

**How it works**:
- `review` and `test` stages run in parallel
- `build` only waits for `test` to complete
- AI review runs independently and posts comments when done
- Pipeline isn't blocked even if review takes a long time

**Pros**:
- ✅ Simple configuration
- ✅ AI review doesn't block deployment
- ✅ Easy to understand
- ✅ Works with existing stage-based pipelines

**Cons**:
- ⚠️ Still shows as part of main pipeline
- ⚠️ Review stage shown even if it's not blocking anything

---

### Strategy 2: Child Pipeline (Complete Isolation)

**Use case**: You want AI reviews completely isolated from your main pipeline.

**File**: `examples/.gitlab-ci-child-pipeline.yml` + `examples/.gitlab-ci-review.yml`

**Main pipeline** (`.gitlab-ci.yml`):
```yaml
stages:
  - trigger
  - test
  - build

trigger_ai_review:
  stage: trigger
  trigger:
    include:
      - local: .gitlab-ci-review.yml
  rules:
    - if: $CI_PIPELINE_SOURCE == "merge_request_event"

test:
  stage: test
  script: npm test
  # Runs immediately without waiting
```

**Review pipeline** (`.gitlab-ci-review.yml`):
```yaml
stages:
  - review

include:
  - remote: 'https://raw.githubusercontent.com/manojlds/drs/main/src/ci/gitlab-ci.template.yml'

ai_review:
  extends: .drs_review
```

**How it works**:
- Main pipeline triggers child pipeline and continues immediately
- Child pipeline runs completely independently
- Shows as separate pipeline in MR view
- Main pipeline is never blocked or delayed

**Pros**:
- ✅ Complete isolation from main pipeline
- ✅ Main pipeline timing unaffected
- ✅ Can use different runners for AI review
- ✅ Review pipeline failure doesn't affect main pipeline (by default)

**Cons**:
- ⚠️ More files to maintain
- ⚠️ Slightly more complex setup
- ⚠️ Child pipeline shows separately in UI

---

### Strategy 3: DAG with Needs (Advanced)

**Use case**: You want fine-grained control over which jobs depend on AI review.

**File**: `examples/.gitlab-ci-needs-strategy.yml`

```yaml
# No stages needed!

include:
  - remote: 'https://raw.githubusercontent.com/manojlds/drs/main/src/ci/gitlab-ci.template.yml'

ai_review_security:
  extends: .drs_review
  variables:
    REVIEW_AGENTS: "security"
  allow_failure: false

test:
  script: npm test
  # Runs in parallel with AI review

build:
  script: npm run build
  needs: ["test"]
  # Only depends on test, not AI review

deploy_staging:
  script: deploy.sh staging
  needs: ["build"]
  # Doesn't require AI review

deploy_production:
  script: deploy.sh production
  needs:
    - build
    - ai_review_security  # Explicitly requires security review
  when: manual
```

**How it works**:
- GitLab creates a Directed Acyclic Graph (DAG) of job dependencies
- Jobs run as soon as their dependencies are met
- `deploy_staging` doesn't wait for AI review
- `deploy_production` requires security review to pass

**Pros**:
- ✅ Maximum flexibility
- ✅ Explicit dependency control
- ✅ Staging deploys don't wait for AI review
- ✅ Production deploys can require AI review
- ✅ No artificial stage delays

**Cons**:
- ⚠️ Requires understanding GitLab DAG
- ⚠️ Can be complex for large pipelines
- ⚠️ Needs careful dependency planning

---

## Comparison Table

| Feature | Simple Parallel | Child Pipeline | DAG with Needs |
|---------|----------------|----------------|----------------|
| Setup Complexity | ⭐ Easy | ⭐⭐ Medium | ⭐⭐⭐ Advanced |
| Main Pipeline Impact | Minimal | None | None |
| Flexibility | Low | Medium | High |
| UI Clarity | Good | Excellent | Good |
| Resource Isolation | No | Yes | No |
| Best For | Most projects | Large teams | Complex workflows |

## Configuration Options

### Review Agents

Choose which AI agents to run:

```yaml
ai_review:
  extends: .drs_review
  variables:
    # All agents (comprehensive but slower)
    REVIEW_AGENTS: "security,quality,style,performance"

    # Security only (fast, focused)
    # REVIEW_AGENTS: "security"

    # Quality and style (no security/performance)
    # REVIEW_AGENTS: "quality,style"
```

### Blocking vs Non-Blocking

Control whether AI review can block your pipeline:

```yaml
# Non-blocking: pipeline continues even if review finds issues
ai_review:
  extends: .drs_review
  allow_failure: true

# Blocking: pipeline fails if review finds issues
ai_review_security:
  extends: .drs_review
  variables:
    REVIEW_AGENTS: "security"
  allow_failure: false  # Block on security issues
```

### Using a Dedicated OpenCode Server

If you run a dedicated OpenCode server (instead of in-process):

```yaml
ai_review:
  extends: .drs_review
  variables:
    OPENCODE_SERVER: "http://opencode.internal:3000"
```

Add this as a CI/CD variable in GitLab settings for easier management.

### Custom Docker Image

If you need additional tools in the review environment:

```yaml
# Create custom Dockerfile based on OpenCode image
FROM ghcr.io/anomalyco/opencode:latest

# Install additional tools
RUN apk add --no-cache git python3

# Then in .gitlab-ci.yml:
ai_review:
  image: registry.gitlab.com/yourorg/yourproject/opencode-custom:latest
  extends: .drs_review
```

## Runner Tags

If you have specific runners for AI workloads:

```yaml
ai_review:
  extends: .drs_review
  tags:
    - ai-review
    - high-memory
```

## Resource Management

For long-running reviews, adjust timeout:

```yaml
ai_review:
  extends: .drs_review
  timeout: 30m  # Default is usually 1h
```

## Caching for Faster Runs

Cache npm packages for faster installations:

```yaml
ai_review:
  extends: .drs_review
  cache:
    key: drs-${CI_COMMIT_REF_SLUG}
    paths:
      - .npm/
  before_script:
    - npm config set cache .npm
```

## Troubleshooting

### Review Job Failing with "No OpenCode CLI Found"

**Problem**: OpenCode CLI not available in container.

**Solution**: Ensure you're using the official OpenCode image:
```yaml
ai_review:
  image: ghcr.io/anomalyco/opencode:latest  # Must use this image
```

### Review Comments Not Posting

**Problem**: Comments not appearing in MR.

**Solutions**:
1. Check `ANTHROPIC_API_KEY` is set as CI/CD variable
2. Verify `CI_JOB_TOKEN` has API permissions (should be automatic)
3. Check project settings allow API access via job token:
   - Settings → CI/CD → Token Access → Allow access to API

### Pipeline Always Waiting for AI Review

**Problem**: Deployment blocked by slow AI review.

**Solution**: Use `needs:` to skip waiting:
```yaml
deploy:
  script: deploy.sh
  needs: ["build"]  # Don't include ai_review here
```

### Running Out of CI Minutes

**Problem**: AI reviews consuming too many CI minutes.

**Solutions**:
1. Use child pipeline strategy to isolate costs
2. Run only security review by default:
   ```yaml
   variables:
     REVIEW_AGENTS: "security"  # Faster
   ```
3. Use dedicated runners for AI reviews
4. Consider shared OpenCode server instead of in-process

## Advanced: Conditional Reviews

Only run AI review on certain conditions:

```yaml
ai_review:
  extends: .drs_review
  rules:
    # Only on MRs to main/production
    - if: $CI_MERGE_REQUEST_TARGET_BRANCH_NAME == "main"
    # Only on MRs with "review" label
    - if: $CI_MERGE_REQUEST_LABELS =~ /review/
    # Only if specific files changed
    - changes:
        - src/**/*.ts
        - src/**/*.js
```

## Example: Full Production Setup

Combining best practices:

```yaml
stages:
  - review
  - test
  - build
  - deploy

include:
  - remote: 'https://raw.githubusercontent.com/manojlds/drs/main/src/ci/gitlab-ci.template.yml'

# Security review (blocking)
ai_review_security:
  extends: .drs_review
  stage: review
  variables:
    REVIEW_AGENTS: "security"
  allow_failure: false  # Block on security issues
  rules:
    - if: $CI_PIPELINE_SOURCE == "merge_request_event"

# Full review (non-blocking)
ai_review_full:
  extends: .drs_review
  stage: review
  variables:
    REVIEW_AGENTS: "quality,style,performance"
  allow_failure: true
  rules:
    - if: $CI_PIPELINE_SOURCE == "merge_request_event"

test:
  stage: test
  image: node:20
  script:
    - npm ci
    - npm test
  cache:
    key: ${CI_COMMIT_REF_SLUG}
    paths:
      - node_modules/

build:
  stage: build
  image: node:20
  script:
    - npm ci
    - npm run build
  artifacts:
    paths:
      - dist/
  needs: ["test"]

deploy:
  stage: deploy
  script:
    - ./deploy.sh
  needs:
    - build
    - ai_review_security  # Requires security review
  only:
    - main
```

## Resources

- [GitLab CI/CD Documentation](https://docs.gitlab.com/ee/ci/)
- [GitLab DAG Pipelines](https://docs.gitlab.com/ee/ci/directed_acyclic_graph/)
- [GitLab Child Pipelines](https://docs.gitlab.com/ee/ci/pipelines/downstream_pipelines.html)
- [DRS Documentation](../README.md)
- [OpenCode Documentation](https://opencode.ai/docs)

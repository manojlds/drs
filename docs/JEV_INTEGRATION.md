# Jev quality evaluation

DRS can optionally run [TypeSafe Jev](https://typesafe.ai/) as a structured software-quality evaluator. Jev is independent of the normal DRS review agent: it produces scalar quality signals and coarse rubric hints, not file-and-line findings.

## Review modes

Configure the default under `review.mode`:

```yaml
review:
  mode: agent # agent | jev | combined
  agent: review/unified-reviewer
  jev:
    timeoutMs: 30000
    maxRetries: 2
    contextWindow: 32768
    failurePolicy: fail # fail | continue-agent
```

- `agent` is the default and preserves the existing DRS review behavior.
- `jev` runs only Jev. It does not start Pi or require an agent model. Its result has no file-level findings or automated fixes.
- `combined` runs the normal DRS reviewer and Jev independently over the same focused diff. Agent findings and the Jev scorecard remain separate.

A workflow review node can override the configured mode with `with.mode`. The precedence is:

1. workflow `with.mode` (`agent`, `jev`, or `combined`);
2. `DRS_REVIEW_MODE` (`agent`, `jev`, or `combined`) when the node uses `configured` or omits an override;
3. `review.mode` from project configuration;
4. the default `agent` mode.

`DRS_REVIEW_MODE` is useful for trusted CI configuration that must select a mode without changing
the repository config. A concrete workflow `with.mode` still takes precedence.

`continue-agent` is valid only in `combined` mode. It preserves a successful agent review when Jev fails and records a sanitized failed-evaluator status. Jev-only evaluation always fails when Jev cannot return a valid scorecard.

## Credentials

Jev-containing modes require the fixed environment variable:

```bash
export JEV_API_KEY="..."
```

DRS does not accept a Jev key, key-variable name, endpoint, custom header, or model in repository configuration. The endpoint and model are fixed in DRS v1. Do not commit the key or write it to workflow artifacts.

Agent-only mode does not read or require `JEV_API_KEY`.

## Privacy and remote processing

Jev evaluation is remote. When `jev` or `combined` mode runs, DRS sends focused review state directly to TypeSafe's API. This may include:

- the review task/label;
- filtered, context-window-compressed diff patches;
- a bounded compression summary;
- allow-listed, bounded repository/change metadata such as platform, repository, title, body, and refs.

DRS deliberately excludes:

- environment variables and credentials;
- GitHub or GitLab tokens;
- `JEV_API_KEY` itself;
- arbitrary `ReviewSource.context` fields and trace collectors;
- the full repository unless content is explicitly present in the selected diff;
- previous Jev evaluations from the upstream request.

Previous scorecards are used only for local comparison when a prior review artifact is explicitly supplied. DRS does not silently load the latest artifact for comparison.

DRS does not proxy Jev calls through a hosted DRS service, persist the key, or add Jev telemetry. Normal TypeSafe service handling applies to data sent to its API.

## Running reviews

Dedicated Jev-only workflows:

```bash
drs workflow run local-jev-review
drs workflow run github-pr-jev-review --input owner=manojlds --input repo=drs --input pr=204
drs workflow run gitlab-mr-jev-review --input project=group/project --input mr=123
```

Override an existing review workflow:

```bash
drs workflow run local-review --input reviewMode=combined
drs workflow run github-pr-review \
  --input owner=manojlds --input repo=drs --input pr=204 \
  --input reviewMode=combined
```

Dedicated Jev workflows are read-only by default. Jev priorities are never converted into inline comments because they do not identify a trustworthy source location.

## Scorecard semantics

Jev evaluates 19 engineering dimensions. Each applicable dimension includes an independent 1–10 score and 0–1 confidence. Conditional dimensions may be marked not applicable when the supplied state lacks evidence. DRS also shows up to five weak priorities and labels weakness text as a rubric hint rather than a root-cause diagnosis.

DRS does not calculate an overall quality grade. A high Jev score does not override failing tests, unresolved agent findings, or project requirements. Jev scores are not merge gates in v1.

In Jev-only mode, `issues` is empty because no file-level issue-producing reviewer ran. It does **not** mean that the code is defect-free.

## Retries, limits, and failures

DRS retries documented transient HTTP failures (`429`, `529`, and `5xx`) with bounded backoff and honors bounded `Retry-After` values. `timeoutMs` and `maxRetries` control the request bounds.

If Jev reports that its token limit was exceeded, reduce the selected context or split the change. DRS does not retry by blindly dropping contracts or tests after a failed request. `contextWindow` controls proactive diff compression; in combined mode DRS uses the tighter of the agent and Jev context budgets.

Errors saved in artifacts or rendered in comments use stable, sanitized codes and messages. Raw upstream response bodies and credentials are not included.

## CI security

Provide `JEV_API_KEY` only to a trusted review-generation job and only when a Jev-containing mode is selected. Never expose it to:

- untrusted fork code;
- jobs that execute pull-request-controlled scripts;
- deterministic posting-only jobs that only consume a canonical review artifact.

For GitHub `pull_request_target`, retain the repository's split trusted-generation/deterministic-posting architecture. For GitLab, use a masked and protected CI/CD variable and ensure the job's protected-branch/environment rules match the intended trust boundary.

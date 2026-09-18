# Jev quality evaluation

DRS can optionally run [TypeSafe Jev](https://typesafe.ai/) as a structured software-quality evaluator. Jev is independent of the normal DRS review agent: it produces scalar quality signals and coarse rubric hints, not file-and-line findings.

## Review modes

Configure the default under `review.mode`:

```yaml
review:
  mode: agent # agent | jev | parallel | combined
  agent: review/unified-reviewer
  jev:
    timeoutMs: 30000
    maxRetries: 2
    contextWindow: 32768
    failurePolicy: fail # fail | continue-agent
```

- `agent` is the default and preserves the existing DRS review behavior.
- `jev` runs only Jev. It does not start Pi or require an agent model. Its result has no file-level findings or automated fixes.
- `parallel` runs the normal DRS reviewer and Jev independently over the same focused diff. Agent findings and the Jev scorecard remain separate.
- `combined` runs Jev first, then gives the DRS reviewer up to five bounded, advisory priorities from the scorecard. The reviewer validates those signals against repository evidence and still performs an independent review.

A workflow review node can override the configured mode with `with.mode`. The precedence is:

1. workflow `with.mode` (`agent`, `jev`, `parallel`, or `combined`);
2. `DRS_REVIEW_MODE` (`agent`, `jev`, `parallel`, or `combined`) when the node uses `configured` or omits an override;
3. `review.mode` from project configuration;
4. the default `agent` mode.

`DRS_REVIEW_MODE` is useful for trusted CI configuration that must select a mode without changing
the repository config. A concrete workflow `with.mode` still takes precedence.

`continue-agent` is valid only in `parallel` mode, where the agent can run without Jev guidance. It preserves a successful agent review when Jev fails and records a sanitized failed-evaluator status. Jev-only and combined evaluation fail when Jev cannot return a valid scorecard.

## Credentials

Jev-containing modes require the fixed environment variable:

```bash
export JEV_API_KEY="..."
```

DRS does not accept a Jev key, key-variable name, endpoint, custom header, or model in repository configuration. The endpoint and model are fixed in DRS v1. Do not commit the key or write it to workflow artifacts.

Agent-only mode does not read or require `JEV_API_KEY`.

## Privacy and remote processing

Jev evaluation is remote. When `jev`, `parallel`, or `combined` mode runs, DRS sends focused review state directly to TypeSafe's API. This may include:

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

Previous scorecards are never sent to TypeSafe. Local artifact comparisons require an explicitly supplied prior artifact. Hosted PR/MR trend baselines are recovered from DRS's canonical summary comment and compared locally after the current evaluation returns.

DRS does not proxy Jev calls through a hosted DRS service, persist the key, or add Jev telemetry. Normal TypeSafe service handling applies to data sent to its API.

## Running reviews

Dedicated Jev-only workflows:

```bash
drs workflow run local-jev-review
drs workflow run github-pr-jev-review --input owner=manojlds --input repo=drs --input pr=204
drs workflow run gitlab-mr-jev-review --input project=group/project --input mr=123
```

Override an existing review workflow for either independent or guided evaluation:

```bash
drs workflow run local-review --input reviewMode=parallel
drs workflow run github-pr-review \
  --input owner=manojlds --input repo=drs --input pr=204 \
  --input reviewMode=combined
```

Dedicated Jev workflows are read-only by default. Jev priorities are never converted into inline comments because they do not identify a trustworthy source location.

## Scorecard semantics

Jev evaluates 19 engineering dimensions. Each applicable dimension includes an independent 1–10 score and 0–1 confidence. Conditional dimensions may be marked not applicable when the supplied state lacks evidence. DRS also shows up to five weak priorities and labels weakness text as a rubric hint rather than a root-cause diagnosis.

DRS does not calculate an overall quality grade. A high Jev score does not override failing tests, unresolved agent findings, or project requirements. Jev scores are not merge gates in v1.

In Jev-only mode, `issues` is empty because no file-level issue-producing reviewer ran. It does **not** mean that the code is defect-free.

## Pull request and merge request trends

On GitHub and GitLab, the first successful Jev evaluation recorded in the canonical DRS summary becomes the stable baseline for that pull or merge request. Later successful runs compare each dimension with that first run and render a `Jev quality trend` table. Updating the summary does not replace the baseline.

The baseline is encoded as versioned machine-readable metadata in the canonical comment. DRS only accepts baseline metadata from a comment whose author matches the provider identity represented by the posting token; lookalike markers from other commenters are ignored. The state contains only the resolved Jev model, head revision, and per-dimension applicability and scores. It does not contain source code, task text, summaries, weakness text, confidence values, credentials, or provider tokens. No extra Jev request is made for trend calculation.

Trend rules are deliberately conservative:

- exact resolved Jev model versions must match; otherwise DRS labels the runs not comparable;
- dimensions applicable in both runs receive a numeric delta;
- dimensions that become applicable are labeled `newly applicable`, not compared with zero;
- dimensions that cease to be applicable are labeled `no longer applicable`;
- movements smaller than 0.75 points are labeled unchanged;
- the trend is advisory because a PR's selected diff/context can evolve as fixes are pushed;
- no overall score is calculated, and score movement does not change tests, findings, severity gates, fix loops, or merge policy.

The baseline starts with the first successful Jev run after trend support is installed; existing comments without baseline metadata are initialized by their next successful run. A failed or skipped Jev evaluation cannot replace an existing baseline.

Local workflows do not have a canonical provider comment, so they do not automatically select a first-run baseline. They continue to support explicit prior-artifact comparison. Automatic branch-scoped local baseline persistence is a separate file-backed extension.

## Retries, limits, and failures

DRS retries documented transient HTTP failures (`429`, `529`, and `5xx`) with bounded backoff and honors bounded `Retry-After` values. `timeoutMs` and `maxRetries` control the request bounds.

If Jev reports that its token limit was exceeded, reduce the selected context or split the change. DRS does not retry by blindly dropping contracts or tests after a failed request. `contextWindow` controls proactive diff compression; in `parallel` and `combined` modes DRS uses the tighter of the agent and Jev context budgets.

Errors saved in artifacts or rendered in comments use stable, sanitized codes and messages. Raw upstream response bodies and credentials are not included.

## CI security

Provide `JEV_API_KEY` only to a trusted review-generation job and only when a Jev-containing mode is selected. Never expose it to:

- untrusted fork code;
- jobs that execute pull-request-controlled scripts;
- deterministic posting-only jobs that only consume a canonical review artifact.

For GitHub `pull_request_target`, retain the repository's split trusted-generation/deterministic-posting architecture. For GitLab, use a masked and protected CI/CD variable and ensure the job's protected-branch/environment rules match the intended trust boundary.

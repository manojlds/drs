# Historical Jev benchmark protocol

## Goal

Evaluate whether Jev produces useful and repeatable quality signals for historical DRS changes,
how those signals overlap with an LLM review, and whether the signals can improve review routing.
The LLM is a comparator, not ground truth. Historical evidence and manual adjudication remain the
ground truth for concrete findings.

## Pilot corpus

`jev-historical-pilot-v1` contains:

- reduced historical defects backed by a later fix, regression test, or accepted finding;
- reduced historical clean controls with focused tests or a clean review and no known follow-up.

`jev-calibration-v1` is a separate companion suite containing focused defect/fixed pairs. Keeping
it separate prevents synthetic calibration fixtures from being presented as historical evidence.

Each known defect may declare `jev.expectedWeakDimensions`. These are the Jev dimensions that the
historical evidence makes relevant. They are not expected file-level findings and must not be used
to calculate LLM recall automatically.

## Execution

Run the Jev-only pilot first:

```bash
drs benchmark review \
  --suite jev-historical-pilot-v1 \
  --review-mode jev \
  --profile isolated \
  --repeat 3 \
  --output out/jev-historical-pilot \
  --live
```

Then verify directional score movement on the focused calibration pairs:

```bash
drs benchmark review \
  --suite jev-calibration-v1 \
  --review-mode jev \
  --profile isolated \
  --repeat 3 \
  --output out/jev-calibration \
  --live
```

Run the shared-context comparison separately with one pinned agent model:

```bash
drs benchmark review \
  --suite jev-historical-pilot-v1 \
  --review-mode combined \
  --model opencode-go/glm-5.2 \
  --profile isolated \
  --repeat 3 \
  --output out/jev-historical-pilot-combined \
  --live
```

For an apples-to-apples comparison of Jev with no-tool LLM evaluators, run:

```bash
drs benchmark quality \
  --suite jev-historical-pilot-v1 \
  --model opencode-go/glm-5.2 \
  --profile isolated \
  --repeat 3 \
  --output out/quality-evaluator-comparison \
  --live
```

The quality benchmark constructs and serializes one prepared state per case. Jev and every LLM
receive those same state bytes and the same 57 question definitions. Generic models run without
tools and evaluate the rubric in bounded batches to avoid provider output limits. The union of the
batches returns the same 19 applicability, score, and weakness indicators and is normalized through
the same priority calculation used for Jev. LLM latency, tokens, and cost are aggregated across all
batches.

The first pilot should use one pinned LLM model. Additional repeatable `--model` options can be
added later for model-sensitivity analysis without changing the benchmark schema.

Only the prepared state is byte-identical. Complete requests differ because Jev and generic model
providers use different protocol framing. LLM rubric confidence is synthetic and must not be
compared with Jev's native probability distributions.

These commands make paid provider calls. Jev-containing modes require `JEV_API_KEY`. Keep generated
reports local because findings and evaluator state may contain source code.

## Automated measurements

The report records:

- each Jev dimension's applicability, score, confidence, and priority status;
- applicability and priority-hit rates for declared expected weak dimensions;
- defect-to-fixed score direction and median delta for each dimension;
- expected-dimension movement separately from the complete 19-dimension output;
- model identity, repetitions, status, token usage, latency, and fixture/source hashes;
- LLM findings and objective adjudication candidates in combined mode.

No overall Jev quality score is calculated. A priority hit is evidence that Jev surfaced a relevant
dimension, not proof that it diagnosed the historical defect.

## Manual adjudication

For every combined run, classify candidate LLM findings as semantic matches, unrelated valid
findings, or false positives. Review every Jev-only signal and disagreement using the same historical
evidence without exposing that evidence to either evaluator during execution.

The pilot report should summarize:

1. Expected-dimension applicability and priority hits on historical defects.
2. Jev movement on each focused defect/fixed calibration pair.
3. Manually adjudicated LLM detection of the known defect.
4. Cases detected by both systems, by only one system, or by neither.
5. Run-to-run instability, latency, tokens, and cost.

Do not publish recall, precision, calibration, or claims about clean-case false positives until the
manual adjudication is complete and the sample is large enough to support those claims.

## Expansion criteria

Expand beyond the pilot only after inspecting all disagreements. New historical cases must pin the
base and head revisions, include a complete Git-generated patch, document confirming evidence, and
avoid leaking a later fix or bug report into evaluator input. Thresholds should be selected on an
older development cohort and frozen before a chronological holdout run.

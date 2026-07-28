# DRS review-system benchmarks

These fixtures primarily regression-test DRS: its review code, unified-reviewer prompt,
context and tool behavior, parsing, filtering, and reporting. The execution model is pinned
for reproducibility. Multiple models may be used as a secondary sensitivity check, but model
ranking is not the suite's primary purpose.

`development-v1` contains small synthetic calibration cases. `historical-v1` contains reduced,
high-confidence regressions and clean changes derived from DRS history. Historical reductions
preserve the review-relevant behavior while removing unrelated repository context.

`capabilities-v1` evaluates the review system holistically with paired baseline/capability
fixtures: global and reviewer-specific project context, skill discovery and selective activation,
repository inspection (including unchanged supporting files), tool behavior, and final outcomes.
Capability telemetry contains only safe observables (paths/hashes, skill names, tool counts, and
application/coverage booleans), never prompts, thinking, tool arguments, or full tool results. The
benchmark report still includes reviewer findings and adjudication candidates and should be treated
as a local evaluation artifact. Pair metadata supports later comparison but does not claim semantic
uplift; recall and precision remain pending adjudication.

Each historical case has an `evidence.yaml` file. Evidence and expectations are never copied into
the temporary review workspace. A positive case requires a concrete later fix, regression test, or
accepted review finding. A negative case requires focused tests or a clean historical review and no
known corrective follow-up for the behavior under test.

Findings still require semantic adjudication. Matching a file, line, severity, or category is only
an adjudication candidate and must not be reported as recall or precision automatically.

Run one pinned model when evaluating a DRS code or prompt change:

```bash
drs benchmark review \
  --suite historical-v1 \
  --model opencode-go/glm-5.2 \
  --profile isolated \
  --repeat 3 \
  --output out/review-benchmark \
  --live
```

Use repeatable `--model` only when checking whether a DRS result is overly dependent on one model.
Live runs are intentionally opt-in because they use provider credentials and incur cost.

Run the capability suite live with:

```bash
drs benchmark review --suite capabilities-v1 --model opencode-go/glm-5.2 \
  --profile isolated --repeat 3 --output out/review-benchmark --live
```

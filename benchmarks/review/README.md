# DRS review-system benchmarks

These fixtures primarily regression-test DRS: its review code, unified-reviewer prompt,
context and tool behavior, parsing, filtering, and reporting. The execution model is pinned
for reproducibility. Multiple models may be used as a secondary sensitivity check, but model
ranking is not the suite's primary purpose.

`development-v1` contains small synthetic calibration cases. `historical-v1` contains reduced,
high-confidence regressions and clean changes derived from DRS history. Historical reductions
preserve the review-relevant behavior while removing unrelated repository context.

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

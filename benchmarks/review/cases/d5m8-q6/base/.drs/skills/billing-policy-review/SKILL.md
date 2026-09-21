---
name: billing-policy-review
description: Review changes to charge calculations that reorder tax, credits, or account adjustments.
---

Billing calculations must preserve the ordering specified by the applicable policy.

1. Read the applicable policy under `rules/` when a calculation reorders tax, credits, or adjustments.
2. Trace a boundary example through the old and new operation order.
3. Check whether each value changes the taxable usage subtotal or settles the account balance after tax; algebraic-looking rewrites may encode different policy.
4. Report a finding only when the changed order produces a concrete policy violation.

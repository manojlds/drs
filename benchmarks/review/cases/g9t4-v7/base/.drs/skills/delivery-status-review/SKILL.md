---
name: delivery-status-review
description: Review changes to delivery wire-code retry classification.
---

Delivery status handling must follow the protocol action matrix rather than generic retry intuition.

1. Read the applicable matrix under `protocol/` when retry code sets change.
2. Convert decimal code constants to four-digit uppercase hexadecimal before looking them up in a `wire_code_hex` column.
3. Distinguish retry, acknowledge, and terminal responses.
4. Check whether retrying an acknowledged response can repeat an accepted side effect.
5. Report only divergences from the matrix introduced by changed classification code.

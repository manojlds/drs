---
name: stable-key-review
description: Review changes to persisted key and token encoders for compatibility.
---

When an encoder contributes to persisted lookup keys, treat its byte representation as a compatibility contract.

1. Read `.compat/key-vectors.txt` for representative established outputs.
2. Compare changed encoders against those outputs byte-for-byte.
3. If the format changes, verify that a migration or dual-read path preserves access to existing records.
4. Report only concrete incompatibilities; do not object to a format change with a complete migration.

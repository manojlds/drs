# Migration Plan: OpenCode SDK → pi-mono

## Status: ✅ IMPLEMENTED

**Branch:** `pi-migration`
**Commit:** `418ec09 feat: migrate from OpenCode SDK to pi-mono`
**Date:** 2026-02-15

All 358 tests pass. `npm run check:all` succeeds.

---

## Overview

Migrated DRS from `@opencode-ai/sdk` / `@opencode-ai/plugin` to pi-mono (`@mariozechner/pi-agent-core` + `@mariozechner/pi-ai`) as the coding agent framework.

**Key benefits:**
- Direct in-process agent execution (no HTTP server/polling)
- Native skills support via [Agent Skills standard](https://agentskills.io/specification) — eliminates custom `drs_skill` tool workaround
- Event-driven message streaming (replaces 2s polling loop)
- TypeBox-based tool definitions (type-safe)
- 31+ model providers with unified API

---

## Architecture Change

### Before (OpenCode)

```
CLI → OpencodeClient → createOpencode() → HTTP Server (in-process)
                                               ↓
                                         SDK HTTP Client
                                               ↓
                                    Poll session.messages() every 2s
                                               ↓
                                         Parse results
```

- Agent definitions: `.opencode/agent/review/*.md` (auto-discovered by OpenCode)
- Tools: `.opencode/tool/` and `.opencode/tools/` (auto-discovered via `@opencode-ai/plugin`)
- Skills: loaded at runtime via `drs_skill` tool (workaround for OpenCode's skill loading limitation)
- Config: `.opencode/opencode.jsonc`

### After (pi-mono) — ✅ Implemented

```
CLI → PiClient → Agent() (direct in-process)
                      ↓
              agent.subscribe(events)
                      ↓
              Event-driven results
```

- Agent definitions: `.opencode/agent/review/*.md` (still loaded by `src/pi/agent-loader.ts`, used as `systemPrompt`)
- Tools: defined programmatically as `AgentTool[]` with TypeBox schemas
- Skills: **native** — pi-mono discovers `.drs/skills/<name>/SKILL.md` and injects into system prompt automatically
- Config: programmatic via `Agent` constructor options

---

## Files Changed

### ✅ Deleted

| File | Reason |
|------|--------|
| `.opencode/opencode.jsonc` | No longer needed; tool/config is programmatic |
| `.opencode/tool/write_json_output.ts` | Rewritten as pi-mono `AgentTool` in `src/pi/tools/` |
| `.opencode/tools/drs_skill.ts` | Eliminated — pi-mono has native skill support |
| `src/opencode/client.ts` | Replaced by `src/pi/client.ts` |
| `src/opencode/client.test.ts` | Replaced by `src/pi/client.test.ts` |
| `src/opencode/opencode-paths.ts` | Replaced by `src/pi/paths.ts` |
| `src/opencode/skill-loader.ts` | Eliminated — pi-mono handles skill discovery natively |
| `src/lib/skills-prompt.ts` | Eliminated — pi-mono auto-generates `<available_skills>` XML |

### ✅ Created

| File | Purpose |
|------|---------|
| `src/pi/client.ts` | Wrapper around pi-mono `Agent` class with session management and event-driven streaming |
| `src/pi/client.test.ts` | Tests for new client (mocks `Agent` class) |
| `src/pi/paths.ts` | Path constant for built-in agent definitions (`.opencode/agent`) |
| `src/pi/tools/write-json-output.ts` | `write_json_output` as pi-mono `AgentTool` with TypeBox schema |

### ✅ Moved

| From | To | Notes |
|------|----|-------|
| `src/opencode/agent-loader.ts` | `src/pi/agent-loader.ts` | Kept as-is; loads `.md` frontmatter, no OpenCode dependency |

### ✅ Edited

| File | Changes |
|------|---------|
| `package.json` | Replaced `@opencode-ai/sdk` + `@opencode-ai/plugin` with `@mariozechner/pi-agent-core@^0.52.12` + `@mariozechner/pi-ai@^0.52.12`; `.opencode` kept in `files` array (still contains agent definitions) |
| `src/lib/config.ts` | Renamed `opencode` config section → `pi` (typed as `Record<string, never>`); removed `CustomProvider` type; removed `OPENCODE_SERVER` env var handling |
| `src/lib/review-core.ts` | Replaced `OpencodeClient` type with `PiClient`; removed `SkillToolCall`/`parseSkillToolResult()`/skill logging; simplified `streamMessages` consumption |
| `src/lib/review-orchestrator.ts` | Replaced `connectToOpenCode()` with `connectToPi()`; removed server startup/health check logic |
| `src/lib/context-loader.ts` | Removed `skillPrompt` parameter from `buildReviewPrompt()` |
| `src/lib/unified-review-executor.ts` | Updated to use `PiClient` via `connectToPi()` |
| `src/lib/description-executor.ts` | Updated to use `PiClient` via `connectToPi()` |
| `src/cli/describe-mr.ts` | Updated help text/error messages |
| `src/cli/describe-pr.ts` | Updated help text/error messages |
| Various test files | Updated mocks to use `PiClient` types |

---

## Implementation Details

### Decisions Made

1. **Agent `.md` location kept at `.opencode/agent/`** — Decided to keep the existing location rather than move to `.pi/agent/` to avoid unnecessary churn. `src/pi/paths.ts` points to `.opencode/agent/` and agent definitions remain unchanged.

2. **Model string format preserved** — The `"provider/model-id"` format (e.g., `"anthropic/claude-sonnet-4-5-20250929"`) is kept in config. `PiClient.parseModelString()` splits it at runtime for `getModel(provider, modelId)`. No breaking change for users.

3. **Variable naming** — Some internal variables in `review-core.ts`, `review-orchestrator.ts`, and `unified-review-executor.ts` are still named `opencode` (the local variable holding the `PiClient` instance). This is cosmetic and does not affect functionality.

4. **TypeBox version mismatch** — `pi-ai` and `pi-agent-core` use different TypeBox versions internally. Resolved with `as any` type casts on the tool parameter schema and `AgentTool<any>` generic in `write-json-output.ts`.

5. **Logger skill methods retained** — `src/lib/logger.ts` still has `skillLoaded()`, `noSkillCalls()`, and `drs_skill` references. These methods are no longer called in the main code paths but were kept to avoid breaking the logger interface. They could be cleaned up in a follow-up.

6. **`pi` config section** — Typed as `Record<string, never>` (empty object) since pi-mono reads API keys from environment variables directly and doesn't need explicit config. The section exists as a placeholder for future pi-specific settings.

### PiClient Implementation

The `PiClient` class in `src/pi/client.ts`:

- **`createSession()`**: Loads agent `.md` definition, strips YAML frontmatter for `systemPrompt`, resolves model via `getModel()`, creates `Agent` instance with `initialState`, fires `agent.prompt()` without awaiting
- **`streamMessages()`**: Uses `agent.subscribe()` to listen for `message_end`, `tool_execution_end`, and `agent_end` events; yields `SessionMessage` objects as an async generator
- **`closeSession()`**: Removes session from internal `Map` (no HTTP calls)
- **`shutdown()`**: Clears all sessions (no server to stop)

### write_json_output Tool

Converted from `@opencode-ai/plugin` `tool()` format to pi-mono `AgentTool` interface:
- Uses `Type.Object()`, `Type.Union()`, `Type.Literal()`, `Type.Optional()` from `@mariozechner/pi-ai`
- `execute()` signature: `(toolCallId: string, params: T) => Promise<ToolResult>`
- Returns `{ content: [{ type: "text", text }], details: {} }`

---

## Concept Mapping: OpenCode → pi-mono

| OpenCode Concept | pi-mono Equivalent |
|---|---|
| `createOpencode()` (starts HTTP server) | `new Agent({...})` (in-process) |
| `createSDKClient()` (HTTP client) | Direct `Agent` method calls |
| `client.session.create()` | `agent.prompt(message)` |
| `client.session.messages()` (polling) | `agent.subscribe(callback)` events |
| `client.session.delete()` | No-op / GC |
| `tool()` from `@opencode-ai/plugin` | `AgentTool` interface with TypeBox |
| `tool.schema.string()` / `.enum()` | `Type.String()` / `Type.Union([Type.Literal()])` |
| `opencode.jsonc` tools config | `tools: [...]` in Agent constructor |
| Agent `.md` with frontmatter | Same — loaded and used as `systemPrompt` |
| `{env:VAR_NAME}` in provider config | `process.env.ANTHROPIC_API_KEY` (auto-read by pi-ai) |
| `drs_skill` tool (runtime skill loading) | Native skill discovery + `<available_skills>` injection |
| `skills-prompt.ts` (tell agent to call tool) | Native `DefaultResourceLoader` with `additionalSkillPaths` |

---

## Known Remaining Items

These are cosmetic or minor items that could be addressed in follow-up work:

1. **`opencode` variable naming** — Local variables named `opencode` in `review-core.ts`, `review-orchestrator.ts`, `unified-review-executor.ts` still hold `PiClient` instances. Renaming to `piClient` would improve clarity.

2. **Logger skill methods** — `src/lib/logger.ts` retains `skillLoaded()`, `noSkillCalls()`, and `drs_skill` references that are no longer used. These can be removed.

3. **Comment in `config-model-overrides.test.ts`** — Line 9 references "opencode.jsonc" in a comment.

4. **Agent path naming** — Built-in agents still live under `.opencode/agent/`. Could be moved to `.drs/agents/` or `.pi/agent/` for consistency, but this would be a separate change.

---

## Risks & Considerations (Post-Implementation)

1. **No remote server mode** — OpenCode supported `OPENCODE_SERVER` for connecting to a remote instance. Pi-mono runs in-process only. Accepted trade-off; remote execution not currently needed.

2. **TypeBox version coupling** — The `as any` casts in the tool definition work but are fragile. If pi-mono aligns their TypeBox versions in a future release, the casts can be removed.

3. **Config migration** — Users with existing `.drs/drs.config.yaml` referencing `opencode:` section will need to update to `pi:`. The `pi` section is currently empty so this is low-impact.

---

## Definition of Done

- [x] `@opencode-ai/sdk` and `@opencode-ai/plugin` fully removed from dependencies
- [x] `@mariozechner/pi-agent-core` and `@mariozechner/pi-ai` installed and used
- [x] `src/opencode/` directory deleted
- [x] `src/pi/` directory with new client, tools, agent-loader, paths
- [x] Skills loaded natively by pi-mono from `.drs/skills/`
- [x] All review modes working (multi-agent, unified, hybrid)
- [x] `npm run check:all` passes (358 tests)
- [ ] No references to "opencode" in source code — **Partial**: agent `.md` path kept at `.opencode/agent/`; some local variable names and comments still use "opencode"

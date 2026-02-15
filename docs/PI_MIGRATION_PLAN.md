# Migration Plan: OpenCode SDK → pi-mono

## Overview

Migrate DRS from `@opencode-ai/sdk` / `@opencode-ai/plugin` to pi-mono (`@mariozechner/pi-agent-core` + `@mariozechner/pi-ai`) as the coding agent framework.

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

### After (pi-mono)

```
CLI → PiClient → Agent() (direct in-process)
                      ↓
              agent.subscribe(events)
                      ↓
              Event-driven results
```

- Agent definitions: `.opencode/agent/review/*.md` (still loaded by our `agent-loader.ts`, used as `systemPrompt`)
- Tools: defined programmatically as `AgentTool[]` with TypeBox schemas
- Skills: **native** — pi-mono discovers `.drs/skills/<name>/SKILL.md` and injects into system prompt automatically
- Config: programmatic via `Agent` constructor options

---

## Files to Change

### Delete

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

### Create

| File | Purpose |
|------|---------|
| `src/pi/client.ts` | New wrapper around pi-mono `Agent` class |
| `src/pi/client.test.ts` | Tests for new client |
| `src/pi/paths.ts` | Path constants (agent definitions directory) |
| `src/pi/tools/write-json-output.ts` | `write_json_output` as pi-mono `AgentTool` |

### Move (unchanged logic)

| From | To | Notes |
|------|----|-------|
| `src/opencode/agent-loader.ts` | `src/pi/agent-loader.ts` | Keep as-is; loads `.md` frontmatter, no OpenCode dependency |

### Edit

| File | Changes |
|------|---------|
| `package.json` | Replace `@opencode-ai/sdk` + `@opencode-ai/plugin` with `@mariozechner/pi-agent-core` + `@mariozechner/pi-ai`; update `files` array |
| `src/lib/config.ts` | Rename `opencode` config section → `pi`; update model format; remove `CustomProvider` (pi-mono has its own); remove `OPENCODE_SERVER` env var |
| `src/lib/review-core.ts` | Replace `OpencodeClient` with `PiClient`; remove `SkillToolCall`/`parseSkillToolResult()`/skill logging; simplify `streamMessages` consumption |
| `src/lib/review-orchestrator.ts` | Replace `connectToOpenCode()` with `createPiClient()`; remove server startup/health check logic |
| `src/lib/context-loader.ts` | Remove `skillPrompt` parameter from `buildReviewPrompt()` |
| CLI commands (`src/cli/*`) | Update help text, error messages referencing "opencode" |

---

## Phase-by-Phase Implementation

### Phase 1: Dependencies & Directory Structure

1. `npm uninstall @opencode-ai/sdk @opencode-ai/plugin`
2. `npm install @mariozechner/pi-agent-core @mariozechner/pi-ai`
3. Create `src/pi/` directory
4. Move `src/opencode/agent-loader.ts` → `src/pi/agent-loader.ts`
5. Create `src/pi/paths.ts`
6. Delete `src/opencode/` directory
7. Delete `.opencode/opencode.jsonc`, `.opencode/tool/`, `.opencode/tools/`

### Phase 2: Convert `write_json_output` Tool

Convert from `@opencode-ai/plugin` format to pi-mono `AgentTool`:

```typescript
// src/pi/tools/write-json-output.ts
import { Type } from "@mariozechner/pi-ai";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { writeJsonOutput } from "../../lib/write-json-output.js";

export const writeJsonOutputTool: AgentTool = {
  name: "write_json_output",
  label: "Write JSON Output",
  description: "Write validated JSON output for DRS agents.",
  parameters: Type.Object({
    outputType: Type.Union([
      Type.Literal("describe_output"),
      Type.Literal("review_output"),
    ]),
    payload: Type.Any({ description: "JSON value or JSON string to write" }),
    pretty: Type.Optional(Type.Boolean()),
    indent: Type.Optional(Type.Number({ minimum: 2, maximum: 8 })),
  }),
  execute: async (toolCallId, params) => {
    const pointer = await writeJsonOutput(params);
    return {
      content: [{ type: "text", text: JSON.stringify(pointer) }],
      details: {},
    };
  },
};
```

### Phase 3: New Client (`src/pi/client.ts`)

Replace the HTTP server/polling model with direct `Agent` instantiation:

```typescript
import { Agent } from "@mariozechner/pi-agent-core";
import { getModel } from "@mariozechner/pi-ai";

export class PiClient {
  // No HTTP server, no port binding, no health checks

  async createSession(options: SessionCreateOptions): Promise<PiSession> {
    // 1. Load agent .md definition (via agent-loader.ts)
    // 2. Read .md content as systemPrompt
    // 3. Resolve model via getModel(provider, modelId)
    // 4. Create Agent with systemPrompt, model, tools
    // 5. Configure skills via DefaultResourceLoader with .drs/skills path
    // 6. Send initial prompt via agent.prompt()
    // 7. Return session wrapper
  }

  async *streamMessages(session: PiSession): AsyncGenerator<SessionMessage> {
    // Subscribe to agent events via agent.subscribe()
    // Yield messages as they arrive (no polling)
    // Complete on agent_end event
  }

  async closeSession(sessionId: string): Promise<void> {
    // Simple cleanup, no HTTP calls
  }

  async shutdown(): Promise<void> {
    // No server to stop
  }
}
```

**Key differences from `OpencodeClient`:**

| Aspect | OpencodeClient | PiClient |
|--------|---------------|----------|
| Initialization | Start HTTP server, wait for ready | Instantiate `Agent` directly |
| Session creation | HTTP POST to server | `agent.prompt(message)` |
| Message streaming | Poll `session.messages()` every 2s | `agent.subscribe()` events |
| Session close | HTTP DELETE | GC / no-op |
| Shutdown | `server.close()` | No-op |
| Skills | Runtime `drs_skill` tool call | Loaded automatically by pi-mono |
| Model resolution | String `"anthropic/claude-sonnet-4-5-20250929"` | `getModel("anthropic", "claude-sonnet-4-5-20250929")` |

### Phase 4: Skills Configuration (Native)

Pi-mono discovers skills automatically. DRS only needs to:

1. **Point pi-mono at `.drs/skills/`** via `DefaultResourceLoader`:
   ```typescript
   const loader = new DefaultResourceLoader({
     additionalSkillPaths: [join(projectRoot, ".drs", "skills")],
   });
   ```

2. **Filter skills per agent** using `skillsOverride`:
   ```typescript
   const loader = new DefaultResourceLoader({
     additionalSkillPaths: [join(projectRoot, ".drs", "skills")],
     skillsOverride: (current) => ({
       skills: current.skills.filter((s) =>
         agentConfig.skills.includes(s.name)
       ),
       diagnostics: current.diagnostics,
     }),
   });
   ```

3. **Delete all custom skill code:**
   - `src/opencode/skill-loader.ts`
   - `src/lib/skills-prompt.ts`
   - `.opencode/tools/drs_skill.ts`
   - `parseSkillToolResult()` and `SkillToolCall` in `review-core.ts`

Existing `.drs/skills/<name>/SKILL.md` files are already compatible with pi-mono's Agent Skills standard format.

### Phase 5: Update Config (`src/lib/config.ts`)

```typescript
// Before
export interface DRSConfig {
  opencode: {
    serverUrl?: string;  // Remote server URL
    provider?: Record<string, CustomProvider>;
  };
  // ...
}

// After
export interface DRSConfig {
  pi: {
    provider?: string;   // e.g., "anthropic", "openai"
    // API keys read from env automatically by pi-ai
  };
  // ...
}
```

- Model format: `"anthropic/claude-sonnet-4-5-20250929"` → split into provider + modelId for `getModel()`
- Remove `OPENCODE_SERVER` env var handling
- Remove `CustomProvider` type (pi-mono has its own custom model config)
- Remove `opencode` config section, replace with `pi`

### Phase 6: Update Review Core & Orchestrator

**`review-core.ts`:**
- Replace `OpencodeClient` type with `PiClient`
- Remove `SkillToolCall` interface and `parseSkillToolResult()`
- Remove skill call tracking and `logger.noSkillCalls()` / `logger.skillLoaded()` calls
- Simplify `streamMessages` loop (no skill tool result detection needed)

**`review-orchestrator.ts`:**
- Replace `connectToOpenCode()` with `createPiClient()` — much simpler (no server startup, port binding, health checks)
- Remove `OPENCODE_SERVER` / `baseUrl` logic

**`context-loader.ts`:**
- Remove `skillPrompt` parameter from `buildReviewPrompt()`

### Phase 7: Tests & Cleanup

- Rewrite `src/pi/client.test.ts` — mock `Agent` class instead of HTTP responses
- Update any test mocks referencing `OpencodeClient`
- Update `package.json` `files` array: remove `.opencode`, keep `.opencode/agent` or move to `.pi/agent`
- Run `npm run check:all`

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

## Risks & Considerations

1. **No remote server mode** — OpenCode supported `OPENCODE_SERVER` for connecting to a remote instance. Pi-mono runs in-process only. If remote execution is needed later, a custom wrapper would be required.

2. **Model ID format** — Current config uses `"anthropic/claude-sonnet-4-5-20250929"`. Need to split into provider + model ID for `getModel()`. This affects `drs.config.yaml` format (breaking change for users).

3. **npm package availability** — Verify `@mariozechner/pi-agent-core` and `@mariozechner/pi-ai` are published to npm before starting implementation.

4. **Agent `.md` location** — Decide whether to keep `.opencode/agent/` or move to `.pi/agent/`. Moving is cleaner but requires updating `agent-loader.ts` paths.

5. **Config file migration** — Users with existing `.drs/drs.config.yaml` referencing `opencode:` section will need to update to `pi:`. Consider adding a deprecation/migration notice.

6. **Skill frontmatter compatibility** — Verify existing `.drs/skills/*/SKILL.md` files meet pi-mono's validation rules (name: 1-64 chars, lowercase a-z/0-9/hyphens, must match directory name).

---

## Definition of Done

- [ ] `@opencode-ai/sdk` and `@opencode-ai/plugin` fully removed from dependencies
- [ ] `@mariozechner/pi-agent-core` and `@mariozechner/pi-ai` installed and used
- [ ] `src/opencode/` directory deleted
- [ ] `src/pi/` directory with new client, tools, agent-loader, paths
- [ ] Skills loaded natively by pi-mono from `.drs/skills/`
- [ ] All review modes working (multi-agent, unified, hybrid)
- [ ] `npm run check:all` passes
- [ ] No references to "opencode" in source code (except agent .md file paths if kept)

# Debugging DRS and OpenCode

This guide helps you debug issues with DRS, especially related to skills, agents, and OpenCode integration.

## Quick Debug Mode

Enable debug logging with the `--debug` flag:

```bash
drs review-local --debug
drs review-pr --owner myorg --repo myrepo --pr 123 --debug
drs review-mr --project 456 --mr 789 --debug
```

## What Debug Mode Shows

When `--debug` is enabled, you'll see:

### 1. Tools Configuration
```
🛠️  DEBUG: Tools available to agents:
  ✓ enabled: Read
  ✓ enabled: Glob
  ✓ enabled: Grep
  ✓ enabled: Bash
  ✓ enabled: write_json_output
  ✗ disabled: Write
  ✗ disabled: Edit
```

### 2. Agent Overlay Creation (if skills are configured)
```
🔍 DEBUG: Creating agent overlay with skills:
  Overlay directory: /tmp/drs-opencode-xyz123
  Default skills: cli-testing
  Project skills found: cli-testing
  Agent modifications:
  📝 review/security: skill tool enabled, 1 skill(s) configured
  📝 review/quality: skill tool enabled, 1 skill(s) configured
```

### 3. Skills Configuration
```
🧩 Agent skill configuration:
  • review/security: cli-testing
  • review/quality: cli-testing

ℹ️  Note: Skills are loaded on-demand via the "skill" tool.
   Agents must actively call the skill tool to access skills.
   Skills are NOT preloaded into the agent context.
```

### 4. OpenCode Configuration
```
🔧 DEBUG: Final OpenCode configuration (after env resolution):
──────────────────────────────────────────────────
Config being passed to OpenCode:
{
  "tools": { ... },
  "logLevel": "DEBUG",
  "agent": { ... }
}
```

### 5. Agent Messages
```
┌── DEBUG: Message sent to review agent
│ Agent: review/security
│ Prompt:
────────────────────────────────────────────────────────────
[Full prompt shown here]
────────────────────────────────────────────────────────────
└── End message for review/security

┌── DEBUG: Full response from review/security
[Complete agent response with all tool calls shown]
└── End response for review/security
```

## Understanding How Skills Work

**Important**: Skills in DRS use OpenCode's on-demand loading mechanism:

1. **Skills are NOT preloaded** - They don't appear in the initial agent prompt
2. **Agents use the `skill` tool** - Agents must actively call the skill tool to load skills
3. **Skills live in the overlay** - Skills are copied to a temporary `.opencode/skills/` directory
4. **Permissions are configured** - Agents are given permission to access skills via frontmatter

### Agent Frontmatter (applied automatically)

When skills are configured, DRS modifies agent frontmatter like this:

```yaml
tools:
  skill: true  # Enables the skill tool

permission:
  skill:
    '*': 'allow'  # Allows access to all skills
```

## Common Issues and Solutions

### Issue: "Skills aren't working"

**Check**:
1. Run with `--debug` to see if skills are configured
2. Look for "Agent skill configuration" in the output
3. Check if "skill tool enabled" appears for your agents

**Verify**:
```bash
# Check your skills are defined
ls -la .drs/skills/

# Check your config references them
cat .drs/drs.config.yaml
```

### Issue: "Agent doesn't seem to use the skill"

**Remember**: Skills are on-demand. The agent must:
1. Know about the skill (via agent instructions or prompt)
2. Decide to call the skill tool
3. Request the specific skill by name

**To verify agents see the skill tool**:
- Look at the debug output for tool configuration
- Ensure `skill: true` appears in tools
- Check OpenCode's DEBUG logs (see below)

### Issue: "Can't see what tools the agent actually receives"

The `--debug` flag shows DRS's logging, but OpenCode has its own internal logging.

**OpenCode Internal Logging**:

OpenCode SDK logs internal details when `logLevel: 'DEBUG'` is set (which `--debug` does automatically). Look for OpenCode's own console output showing:
- Tool definitions sent to the AI model
- Skill tool registrations
- Agent system prompts

If you need even more detailed logging from OpenCode, you can:

1. Check OpenCode's documentation for environment variables:
   ```bash
   export OPENCODE_DEBUG=1  # Example - check OpenCode docs
   drs review-local --debug
   ```

2. Review OpenCode SDK source:
   ```bash
   npm list @opencode-ai/sdk
   # Check node_modules/@opencode-ai/sdk for logging options
   ```

## Debugging Skills Step-by-Step

### 1. Verify Skills Exist

```bash
# Check project skills directory
ls -la .drs/skills/

# Each skill should have a SKILL.md file
cat .drs/skills/cli-testing/SKILL.md
```

### 2. Verify Configuration

```bash
# Check DRS config
cat .drs/drs.config.yaml
```

Expected format:
```yaml
review:
  default:
    skills:
      - cli-testing  # Default skills for all agents
  agents:
    - security
    - name: quality
      skills:
        - cli-testing  # Per-agent override
```

### 3. Run with Debug Mode

```bash
drs review-local --debug 2>&1 | tee debug.log
```

### 4. Check Debug Output

Look for these sections in order:
1. ✅ "Tools available to agents" - skill should NOT be listed (it's added per-agent)
2. ✅ "Creating agent overlay with skills" - shows overlay being created
3. ✅ "Agent skill configuration" - shows which agents have skills
4. ✅ "Agent modifications" - shows "skill tool enabled" for each agent
5. ✅ Agent prompts and responses

### 5. Verify Overlay Structure

When debug mode shows the overlay directory (e.g., `/tmp/drs-opencode-xyz123`), you can inspect it:

```bash
# While DRS is running (overlay gets deleted after)
# Copy the overlay directory from debug output
ls -la /tmp/drs-opencode-xyz123/.opencode/

# Check agents have been modified
grep -A5 "^tools:" /tmp/drs-opencode-xyz123/.opencode/agent/review/security.md

# Check skills are present
ls -la /tmp/drs-opencode-xyz123/.opencode/skills/
```

Expected structure:
```
/tmp/drs-opencode-xyz123/
└── .opencode/
    ├── agent/
    │   └── review/
    │       ├── security.md
    │       ├── quality.md
    │       └── ...
    └── skills/
        └── cli-testing/
            └── SKILL.md
```

## Advanced Debugging

### Inspect Agent Frontmatter Changes

Use the test script to verify overlay structure:

```bash
node test-overlay.js
```

This validates:
- Agents are copied correctly
- Skills are copied correctly
- Frontmatter includes skill tool configuration

### OpenCode Server Logs

If using a remote OpenCode server (not in-process), check server logs:

```bash
# If running OpenCode server separately
opencode serve --log-level debug
```

### Network Debugging

If using `--opencode-url`:

```bash
# Test connectivity
curl http://localhost:8000/health

# Run with debug
drs review-local --opencode-url http://localhost:8000 --debug
```

## Environment Variables

DRS respects these environment variables:

- `ANTHROPIC_API_KEY` - Claude API key (for default provider)
- `GITLAB_TOKEN` - GitLab access token
- `GITHUB_TOKEN` - GitHub access token
- `DRS_PROJECT_ROOT` - Override project root (set internally)

Custom providers can use environment variables via config:
```yaml
provider:
  custom-provider:
    type: openai-compatible
    options:
      apiKey: "{env:CUSTOM_API_KEY}"
```

## Getting Help

If issues persist after following this guide:

1. **Collect debug output**: Run with `--debug` and save output
2. **Check configuration**: Share your `.drs/drs.config.yaml` (redact sensitive info)
3. **Verify skills**: Confirm skills exist in `.drs/skills/`
4. **Check versions**: Run `npm list @opencode-ai/sdk`
5. **Open an issue**: https://github.com/manojlds/drs/issues

Include:
- Full command used
- Debug output (redact API keys)
- DRS version: `drs --version`
- Node version: `node --version`
- OpenCode SDK version

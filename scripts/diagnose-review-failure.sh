#!/bin/bash

# Diagnostic script to help debug DRS review failures
# Usage: ./scripts/diagnose-review-failure.sh

echo "🔍 DRS Review Failure Diagnostics"
echo "=================================="
echo ""

# Check Node version
echo "1. Node.js Version:"
node --version
echo ""

# Check if config exists
echo "2. DRS Configuration:"
if [ -f ".drs/drs.config.yaml" ]; then
    echo "   ✓ .drs/drs.config.yaml found"
    echo ""
    echo "   Agents configured:"
    grep -A 10 "agents:" .drs/drs.config.yaml | head -15
    echo ""
    echo "   Default model:"
    grep "defaultModel:" .drs/drs.config.yaml || echo "   (not set)"
else
    echo "   ✗ .drs/drs.config.yaml not found"
fi
echo ""

# Check OpenCode config
echo "3. OpenCode Configuration:"
if [ -f ".opencode/opencode.jsonc" ]; then
    echo "   ✓ .opencode/opencode.jsonc found"
    echo ""
    echo "   Agent models configured:"
    grep -A 2 "\"review/" .opencode/opencode.jsonc | grep -E "(review/|model)" | head -20
else
    echo "   ✗ .opencode/opencode.jsonc not found"
fi
echo ""

# Check environment variables
echo "4. Environment Variables:"
echo "   ANTHROPIC_API_KEY: ${ANTHROPIC_API_KEY:+<set>}${ANTHROPIC_API_KEY:-<not set>}"
echo "   OPENCODE_SERVER: ${OPENCODE_SERVER:-<not set>}"
echo "   REVIEW_DEFAULT_MODEL: ${REVIEW_DEFAULT_MODEL:-<not set>}"
echo "   REVIEW_AGENT_SECURITY_MODEL: ${REVIEW_AGENT_SECURITY_MODEL:-<not set>}"
echo ""

# Check agent markdown files
echo "5. Agent Markdown Files:"
if [ -d ".opencode/agent/review" ]; then
    echo "   ✓ Agent directory exists"
    echo ""
    echo "   Agents found:"
    for agent in .opencode/agent/review/*.md; do
        name=$(basename "$agent" .md)
        # Check if model is in frontmatter (it shouldn't be)
        if grep -q "^model:" "$agent"; then
            echo "   ⚠️  $name (WARNING: has model in frontmatter - this will override config!)"
        else
            echo "   ✓ $name"
        fi
    done
else
    echo "   ✗ Agent directory not found"
fi
echo ""

# Check package installation
echo "6. Package Status:"
if [ -f "package.json" ]; then
    echo "   ✓ package.json found"
    if [ -d "node_modules" ]; then
        echo "   ✓ node_modules exists"
    else
        echo "   ✗ node_modules not found - run 'npm install'"
    fi
else
    echo "   ✗ package.json not found"
fi
echo ""

# Common issues
echo "7. Common Issues Checklist:"
echo ""
echo "   Issue: All agents timeout after 120 seconds"
echo "   Possible causes:"
echo "   - Model configuration is missing or incorrect"
echo "   - API credentials (ANTHROPIC_API_KEY) are invalid"
echo "   - Model overrides not being passed to OpenCode client"
echo "   - Agent markdown files have 'model:' in frontmatter (overrides config)"
echo ""
echo "   Issue: Silent failures with no issues found"
echo "   Possible causes:"
echo "   - Error handling is swallowing failures"
echo "   - Check if 'All review agents failed!' message appears"
echo "   - If not, update to latest version with proper failure handling"
echo ""
echo "   Issue: Using wrong models (e.g., Anthropic instead of GLM)"
echo "   Possible causes:"
echo "   - Agent frontmatter has hardcoded models (check #5 above)"
echo "   - Model overrides not properly configured in DRS config"
echo "   - review-pr/review-mr not passing modelOverrides to OpenCode"
echo ""

echo "=================================="
echo ""
echo "To see model overrides being applied, look for:"
echo "  '📋 Applying model overrides from DRS config:'"
echo "when running drs review commands"
echo ""
echo "To enable verbose logging, set: DEBUG=opencode:*"

"""Claude Code SDK integration for DRS."""

import json
import logging
import sys
from pathlib import Path

from claude_code_sdk import (
    AssistantMessage,
    ClaudeCodeOptions,
    ResultMessage,
    TextBlock,
    ToolResultBlock,
    ToolUseBlock,
    UserMessage,
    query,
)

# GitLab JSON format instruction template for main agent
GITLAB_JSON_FORMAT_INSTRUCTION = """
After the @code-reviewer subagent completes its analysis, you must:
1. Review the subagent's findings
2. Convert them into valid GitLab Code Quality JSON format
3. Provide the JSON within a code block for reliable parsing

GitLab JSON format requirements:
- Return a JSON array where each finding is an object with these exact fields:
- "description": Brief issue description with recommendation
- "check_name": Category like "naming", "performance", "maintainability", etc.
- "fingerprint": Use MD5 hash of "filepath:line:description"
- "severity": One of "blocker", "major", "minor", "info"
- "location": Object with "path" (file path) and "lines" with "begin" (line num)

Example format:
```json
[
  {
    "description": "Variable uses camelCase instead of snake_case.",
    "check_name": "naming",
    "fingerprint": "abc123def456",
    "severity": "minor",
    "location": {
      "path": "drs/main.py",
      "lines": {
        "begin": 42
      }
    }
  }
]
```

CRITICAL: You may provide explanatory text, but the JSON must be enclosed in a
```json code block exactly as shown above. The JSON within the code block must
be valid and parseable.
"""


def create_claude_options():
    """Create Claude Code options for code review."""
    # Look for Claude settings files
    cwd = Path.cwd()
    settings_path = None

    # Check for settings files in order of precedence
    potential_settings = [
        cwd / ".claude" / "settings.local.json",
        cwd / ".claude" / "settings.json",
        Path.home() / ".config" / "claude" / "settings.json",
    ]

    for settings_file in potential_settings:
        if settings_file.exists():
            settings_path = str(settings_file)
            break

    options = ClaudeCodeOptions(
        max_turns=3,
        cwd=cwd,
        allowed_tools=["Read", "Grep", "Glob", "Bash"],
        permission_mode="acceptEdits",
        settings=settings_path,  # Pass settings file if found
    )

    return options


def log_claude_settings(options, debug=False):
    """Log the Claude settings being used."""
    logger = logging.getLogger(__name__)

    if debug:
        logger.debug("Claude Code Options:")
        logger.debug("  Working directory: %s", options.cwd)
        logger.debug("  Max turns: %s", options.max_turns)
        logger.debug("  Permission mode: %s", options.permission_mode)
        logger.debug("  Allowed tools: %s", options.allowed_tools)
        logger.debug("  Settings file: %s", options.settings or "None")
        logger.debug("  Model: %s", options.model or "Default")

        if options.settings:
            try:
                import json

                with open(options.settings) as f:
                    settings_content = json.load(f)
                logger.debug(
                    "  Settings content preview: %s",
                    {k: v for k, v in list(settings_content.items())[:5]},
                )
            except Exception as e:
                logger.debug("  Could not read settings file: %s", e)


def create_review_prompt(context_description, git_commands, output_format):
    """Create the review prompt for the code-reviewer subagent."""
    # Check if this is a full review mode
    is_full_review = "Full codebase review" in git_commands

    if is_full_review:
        base_prompt = (
            f"@code-reviewer please perform a comprehensive review of the entire "
            f"codebase for code quality, security, and best practices.\n\n"
            f"Context: {context_description}\n\n"
            f"Instructions: {git_commands}\n\n"
            f"Use your tools (Read, Grep, Glob, Bash) to analyze the codebase "
            f"comprehensively. Focus on architecture, security patterns, code quality, "
            f"and adherence to best practices.\n\n"
        )
    else:
        base_prompt = (
            f"@code-reviewer please review the current repository changes "
            f"using the provided git commands.\n\n"
            f"Context: {context_description}\n\n"
            f"Git Commands to Execute:\n{git_commands}\n\n"
        )

    if output_format == "gitlab-json":
        # For JSON mode, let main agent process subagent output and format as JSON
        json_instruction = (
            "\n\nFirst, have the @code-reviewer subagent analyze the code and provide "
            "detailed findings. Then, you will process those findings and format them "
            "according to the GitLab JSON requirements below:\n\n"
        )
        return base_prompt + json_instruction + GITLAB_JSON_FORMAT_INSTRUCTION
    else:
        # For text mode, return full output without summarizing
        full_output_instruction = (
            "\n\nIMPORTANT: Once the @code-reviewer subagent completes its analysis, "
            "you MUST return the subagent's complete output exactly as provided, "
            "without any summarization, modification, or additional commentary. "
            "The user needs the full detailed review output from the subagent.\n\n"
        )
        return (
            base_prompt
            + full_output_instruction
            + "The subagent should provide a comprehensive text review in "
            "markdown format suitable for human reading. Return its complete output."
        )


def extract_final_assistant_message(all_messages):
    """Extract the final assistant message content from Claude SDK messages."""
    final_review = ""
    for message in reversed(all_messages):
        if hasattr(message, "content") and message.content:
            # Look for the last assistant message with actual content
            if hasattr(message.content[0], "text"):
                final_review = message.content[0].text
                break
        elif isinstance(message, str):
            # Handle string messages
            final_review = message
            break

    return final_review


def extract_json_from_response(response_text):
    """Extract JSON from code block or raw response."""
    import re

    # First, try to find JSON within ```json code blocks
    json_pattern = r"```json\s*\n(.*?)\n```"
    match = re.search(json_pattern, response_text, re.DOTALL)

    if match:
        return match.group(1).strip()

    # If no code block found, try to find JSON by looking for array brackets
    # This handles cases where agent outputs JSON without code blocks
    array_pattern = r"(\[.*\])"
    match = re.search(array_pattern, response_text, re.DOTALL)

    if match:
        return match.group(1).strip()

    # Last resort - return the original text stripped
    return response_text.strip()


def validate_and_format_json(final_review):
    """Validate and format JSON output from the agent response."""
    try:
        # Extract JSON from the response (handles code blocks or raw JSON)
        json_content = extract_json_from_response(final_review)

        # Try to parse the extracted JSON
        findings = json.loads(json_content)
        if not isinstance(findings, list):
            raise ValueError("JSON response is not an array")
        return json.dumps(findings, indent=2)
    except (json.JSONDecodeError, ValueError) as e:
        print(f"Error: Agent did not return valid JSON: {e}")
        print("Raw response:")
        print(final_review)
        print("\nExtracted JSON attempt:")
        try:
            extracted = extract_json_from_response(final_review)
            print(extracted)
        except Exception:
            print("Could not extract JSON content")
        sys.exit(1)


async def run_code_review(review_prompt, debug: bool = False):
    """Run the code review using Claude Code SDK and return all messages."""
    logger = logging.getLogger(__name__)
    options = create_claude_options()

    # Log settings being used
    log_claude_settings(options, debug)

    if debug:
        logger.debug("Review prompt (truncated to 500 chars): %s", review_prompt[:500])

    all_messages = []
    async for message in query(prompt=review_prompt, options=options):
        all_messages.append(message)
        if debug:
            try:
                msg_type = message.__class__.__name__
                preview = ""

                if isinstance(message, AssistantMessage | UserMessage):
                    if hasattr(message, "content") and message.content:
                        block = message.content[0]
                        if isinstance(block, TextBlock):
                            preview = block.text[:300]
                        elif isinstance(block, ToolUseBlock):
                            tool_name = getattr(block, "name", "unknown")
                            tool_input = getattr(block, "input", {})
                            # Show tool name and key parameters
                            if "file_path" in tool_input:
                                preview = (
                                    f"Tool:{tool_name}(file={tool_input['file_path']})"
                                )
                            elif "pattern" in tool_input:
                                preview = (
                                    f"Tool:{tool_name}(pattern={tool_input['pattern']})"
                                )
                            elif "command" in tool_input:
                                cmd = tool_input["command"][:50]
                                preview = f"Tool:{tool_name}(cmd={cmd})"
                            else:
                                preview = f"Tool:{tool_name}({str(tool_input)[:100]})"
                        elif isinstance(block, ToolResultBlock):
                            tool_id = getattr(block, "tool_use_id", "unknown")
                            is_error = getattr(block, "is_error", False)
                            content = getattr(block, "content", "")
                            if is_error:
                                preview = f"ToolResult:ERROR({tool_id})"
                            else:
                                # Show first line of result
                                first_line = (
                                    str(content)[:200].split("\n")[0]
                                    if content
                                    else "empty"
                                )
                                preview = f"ToolResult:OK({tool_id}) - {first_line}"
                        else:
                            preview = f"content_type={type(block)}"
                    else:
                        preview = "no_content"
                elif isinstance(message, ResultMessage):
                    preview = (
                        f"result: error={message.is_error} "
                        f"cost={message.total_cost_usd} turns={message.num_turns}"
                    )
                elif hasattr(message, "content"):
                    # Handle other message types with content
                    try:
                        preview = str(message.content)[:300]
                    except Exception:
                        preview = f"content_type={type(message.content)}"
                else:
                    preview = "no_content_attr"

                logger.debug("Received %s - %s", msg_type, preview)

            except Exception as e:  # best-effort debug logging
                logger.debug(
                    "Received message (error in debug): %s - %r",
                    message.__class__.__name__,
                    str(e),
                )

    if debug:
        logger.debug(
            "Completed Claude Code query; total messages: %d",
            len(all_messages),
        )

    return all_messages

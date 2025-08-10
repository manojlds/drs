"""Claude Code SDK integration for DRS."""

import json
import sys
from pathlib import Path

from claude_code_sdk import ClaudeCodeOptions, query

# GitLab JSON format instruction template
GITLAB_JSON_FORMAT_INSTRUCTION = """
        IMPORTANT: Output your findings as valid GitLab Code Quality JSON format only.

        Return a JSON array where each finding is an object with these exact fields:
        - "description": Brief issue description with recommendation
        - "check_name": Category like "naming", "performance", "maintainability", etc.
        - "fingerprint": Use MD5 hash of "filepath:line:description"
        - "severity": One of "blocker", "major", "minor", "info"
        - "location": Object with "path" (file path) and "lines" with "begin" (line num)

        Example format:
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

        Output ONLY the JSON array, no other text.
        """


def create_claude_options():
    """Create Claude Code options for code review."""
    return ClaudeCodeOptions(
        max_turns=3,
        cwd=Path.cwd(),
        allowed_tools=["Read", "Grep", "Glob", "Bash"],
        permission_mode="acceptEdits",
    )


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
        return base_prompt + GITLAB_JSON_FORMAT_INSTRUCTION
    else:
        return (
            base_prompt +
            "Please provide a comprehensive text review in markdown format "
            "suitable for human reading."
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


def validate_and_format_json(final_review):
    """Validate and format JSON output from the subagent."""
    try:
        # Try to parse the response as JSON
        findings = json.loads(final_review.strip())
        if not isinstance(findings, list):
            raise ValueError("JSON response is not an array")
        return json.dumps(findings, indent=2)
    except (json.JSONDecodeError, ValueError) as e:
        print(f"Error: Subagent did not return valid JSON: {e}")
        print("Raw response:")
        print(final_review)
        sys.exit(1)


async def run_code_review(review_prompt):
    """Run the code review using Claude Code SDK and return all messages."""
    options = create_claude_options()
    all_messages = []
    async for message in query(prompt=review_prompt, options=options):
        all_messages.append(message)

    return all_messages

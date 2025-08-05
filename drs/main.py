from claude_code_sdk import query, ClaudeCodeOptions
from pathlib import Path
import anyio
import argparse
import os
import subprocess
import sys
import json

def get_mr_id():
    """Get merge request ID from CI environment or command line arguments."""
    # Check if running in GitLab CI/CD
    if os.getenv('CI_PIPELINE_SOURCE') == 'merge_request_event':
        mr_id = os.getenv('CI_MERGE_REQUEST_ID')
        if mr_id:
            print(f"Detected GitLab CI/CD context. MR ID: {mr_id}")
            return mr_id
        else:
            print("Error: Running in GitLab CI/CD but no MR ID found")
            sys.exit(1)
    
    # Parse command line arguments for local usage
    parser = argparse.ArgumentParser(description='DRS - Diff Review System')
    parser.add_argument('--mr-id', type=str, required=True, 
                       help='GitLab Merge Request ID to review')
    args = parser.parse_args()
    
    print(f"Local mode. MR ID: {args.mr_id}")
    return args.mr_id

def get_mr_diff(mr_id):
    """Fetch merge request diff using glab CLI."""
    try:
        result = subprocess.run(
            ['glab', 'mr', 'diff', mr_id],
            capture_output=True,
            text=True,
            check=True
        )
        return result.stdout
    except subprocess.CalledProcessError as e:
        print(f"Error fetching MR diff: {e.stderr}")
        sys.exit(1)
    except FileNotFoundError:
        print("Error: glab CLI not found. Please install GitLab CLI (glab)")
        sys.exit(1)

def get_mr_info(mr_id):
    """Fetch merge request information using glab CLI."""
    try:
        result = subprocess.run(
            ['glab', 'mr', 'view', mr_id, '--output', 'json'],
            capture_output=True,
            text=True,
            check=True
        )
        return json.loads(result.stdout)
    except subprocess.CalledProcessError as e:
        print(f"Error fetching MR info: {e.stderr}")
        sys.exit(1)
    except (FileNotFoundError, json.JSONDecodeError):
        # Fallback to basic view if JSON not available
        try:
            result = subprocess.run(
                ['glab', 'mr', 'view', mr_id],
                capture_output=True,
                text=True,
                check=True
            )
            return {'title': 'MR Info', 'description': result.stdout}
        except subprocess.CalledProcessError:
            return {'title': f'Merge Request {mr_id}', 'description': 'Unable to fetch MR details'}

CODE_REVIEW_PROMPT = """
You are an expert code reviewer analyzing a GitLab merge request. Your role is to:

1. **Security Analysis**: Identify potential security vulnerabilities, data exposure, injection risks
2. **Code Quality**: Review for maintainability, readability, and adherence to best practices
3. **Bug Detection**: Spot potential runtime errors, edge cases, and logical issues
4. **Performance**: Highlight performance concerns and optimization opportunities
5. **Architecture**: Assess design patterns and architectural decisions

**Review Guidelines:**
- Focus on significant issues that could impact functionality, security, or maintainability
- Provide specific, actionable feedback with suggested improvements
- Use severity levels: CRITICAL, MAJOR, MINOR, SUGGESTION
- Include file paths and approximate line numbers where relevant
- Be constructive and educational in your feedback

**Output Format:**
Provide structured feedback as:
```
## Code Review Summary
[Brief overall assessment]

## Issues Found

### [SEVERITY] - [Issue Title]
**File:** `path/to/file.ext` (lines X-Y)
**Description:** [Detailed explanation]
**Recommendation:** [Specific suggestion]

[Repeat for each issue]

## Positive Observations
[Highlight good practices or improvements]
```

Analyze the following merge request:
"""

def create_claude_options():
    """Create Claude Code options for code review."""
    return ClaudeCodeOptions(
        max_turns=5,
        system_prompt=CODE_REVIEW_PROMPT,
        cwd=Path.cwd(),
        allowed_tools=["Read", "Grep", "Bash"],
        permission_mode="acceptEdits"
    )

async def main():
    # Get MR ID from environment or CLI
    mr_id = get_mr_id()
    
    # Fetch MR information and diff
    print("Fetching merge request information...")
    mr_info = get_mr_info(mr_id)
    
    print("Fetching merge request diff...")
    mr_diff = get_mr_diff(mr_id)
    
    if not mr_diff.strip():
        print("No changes found in the merge request.")
        return
    
    # Prepare review prompt
    review_prompt = f"""
## Merge Request Information
**Title:** {mr_info.get('title', 'N/A')}
**Description:** {mr_info.get('description', 'N/A')}

## Diff to Review
```diff
{mr_diff}
```

Please provide a comprehensive code review of the above merge request.
"""
    
    print("\n" + "="*60)
    print("STARTING CODE REVIEW")
    print("="*60 + "\n")
    
    # Create Claude options and run review
    options = create_claude_options()
    
    async for message in query(prompt=review_prompt, options=options):
        print(message)


def cli_main():
    """CLI entry point for the drs command."""
    anyio.run(main)

if __name__ == "__main__":
    cli_main() 
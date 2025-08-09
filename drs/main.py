from claude_code_sdk import query, ClaudeCodeOptions
from pathlib import Path
import anyio
import argparse
import os
import subprocess
import sys
import json
import hashlib
from enum import Enum

class OutputFormat(Enum):
    TEXT = "text"
    GITLAB_JSON = "gitlab-json"
    AUTO = "auto"

def parse_cli_args():
    """Parse command line arguments."""
    parser = argparse.ArgumentParser(description='DRS - Diff Review System')
    parser.add_argument('--mr-id', type=str, 
                       help='GitLab Merge Request ID to review')
    parser.add_argument('--format', type=str, choices=['text', 'gitlab-json', 'auto'], 
                       default='auto', help='Output format (default: auto)')
    parser.add_argument('--local', action='store_true',
                       help='Force local git diff mode (ignore MR context)')
    parser.add_argument('-o', '--output', type=str,
                       help='Output file path (default: stdout)')
    return parser.parse_args()

def detect_context():
    """Detect if running in GitLab CI/CD environment."""
    return {
        'is_ci': bool(os.getenv('CI')),
        'is_mr': os.getenv('CI_PIPELINE_SOURCE') == 'merge_request_event',
        'mr_id': os.getenv('CI_MERGE_REQUEST_ID')
    }

def determine_review_context(args):
    """Determine review context and mode."""
    context = detect_context()
    
    if args.local:
        return 'local', None
    
    if context['is_mr'] and context['mr_id']:
        print(f"Detected GitLab CI/CD context. MR ID: {context['mr_id']}")
        return 'mr', context['mr_id']
    
    if args.mr_id:
        print(f"Local mode with MR ID: {args.mr_id}")
        return 'mr', args.mr_id
    
    print("Local git diff mode")
    return 'local', None

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

def get_local_git_diff():
    """Get local git diff for staged, unstaged, and untracked changes."""
    try:
        # First try to get staged changes
        staged = subprocess.run(
            ['git', 'diff', '--cached'],
            capture_output=True,
            text=True,
            check=False
        )
        
        # Then get unstaged changes
        unstaged = subprocess.run(
            ['git', 'diff'],
            capture_output=True,
            text=True,
            check=False
        )
        
        # Get untracked files
        untracked = subprocess.run(
            ['git', 'ls-files', '--others', '--exclude-standard'],
            capture_output=True,
            text=True,
            check=False
        )
        
        diff_content = ''
        if staged.stdout.strip():
            diff_content += "# Staged Changes\n" + staged.stdout + "\n"
        
        if unstaged.stdout.strip():
            diff_content += "# Unstaged Changes\n" + unstaged.stdout + "\n"
        
        # Add untracked files info
        if untracked.stdout.strip():
            diff_content += "# Untracked Files (New Files Added)\n"
            untracked_files = untracked.stdout.strip().split('\n')
            for file_path in untracked_files:
                if file_path.strip():
                    diff_content += f"\n## New File: {file_path}\n"
                    try:
                        with open(file_path, 'r', encoding='utf-8') as f:
                            file_content = f.read()
                            diff_content += f"```\n{file_content}\n```\n"
                    except (UnicodeDecodeError, FileNotFoundError, PermissionError):
                        diff_content += f"[Binary file or unable to read: {file_path}]\n"
        
        if not diff_content.strip():
            # If no staged/unstaged changes, try last commit
            last_commit = subprocess.run(
                ['git', 'diff', 'HEAD~1..HEAD'],
                capture_output=True,
                text=True,
                check=False
            )
            if last_commit.stdout.strip():
                diff_content = "# Last Commit Changes\n" + last_commit.stdout
        
        return diff_content
    except Exception as e:
        print(f"Error fetching local git diff: {e}")
        sys.exit(1)

def create_claude_options():
    """Create Claude Code options for code review."""
    return ClaudeCodeOptions(
        max_turns=3,
        cwd=Path.cwd(),
        allowed_tools=["Read", "Grep", "Glob", "Bash"],
        permission_mode="acceptEdits"
    )

def generate_fingerprint(file_path, line, description):
    """Generate a unique fingerprint for GitLab JSON format."""
    content = f"{file_path}:{line}:{description}"
    return hashlib.md5(content.encode()).hexdigest()

def parse_text_review_to_gitlab_json(review_text):
    """Convert structured text review to GitLab Code Quality JSON format."""
    import re
    
    findings = []
    
    # Pattern to match issue blocks in the review
    issue_pattern = r'### (CRITICAL|MAJOR|MINOR|SUGGESTION) - (.+?)\n\*\*File:\*\* `(.+?)` \(line (\d+)\)\n\*\*Category:\*\* (.+?)\n\*\*Description:\*\* (.+?)\n\*\*Recommendation:\*\* (.+?)\n\*\*Confidence:\*\* (.+?)\n'
    
    matches = re.findall(issue_pattern, review_text, re.DOTALL)
    
    severity_mapping = {
        'CRITICAL': 'blocker',
        'MAJOR': 'major', 
        'MINOR': 'minor',
        'SUGGESTION': 'info'
    }
    
    for match in matches:
        severity, title, file_path, line_num, category, description, recommendation, confidence = match
        
        # Clean up the extracted text
        description = description.strip()
        recommendation = recommendation.strip()
        
        finding = {
            "description": f"{title.strip()} - {description} Recommendation: {recommendation}",
            "check_name": category.strip().replace('|', '_'),
            "fingerprint": generate_fingerprint(file_path, line_num, description),
            "severity": severity_mapping.get(severity, 'info'),
            "location": {
                "path": file_path.strip(),
                "lines": {
                    "begin": int(line_num)
                }
            }
        }
        findings.append(finding)
    
    return findings

async def main():
    # Parse CLI arguments
    args = parse_cli_args()
    
    # Determine review context
    context_type, mr_id = determine_review_context(args)
    
    # Determine output format
    output_format = args.format
    if output_format == 'auto':
        context = detect_context()
        output_format = 'gitlab-json' if context['is_ci'] else 'text'
    
    print(f"Output format: {output_format}")
    
    # Get diff content based on context
    if context_type == 'mr':
        print("Fetching merge request information...")
        mr_info = get_mr_info(mr_id)
        
        print("Fetching merge request diff...")
        diff_content = get_mr_diff(mr_id)
        context_info = f"MR {mr_id}: {mr_info.get('title', 'N/A')}"
    else:
        print("Getting local git diff...")
        diff_content = get_local_git_diff()
        context_info = "Local git changes"
    
    if not diff_content.strip():
        print("No changes found to review.")
        return
    
    print("\n" + "="*60)
    print(f"STARTING CODE REVIEW - {context_info}")
    print("="*60 + "\n")
    
    # Use code-reviewer subagent
    review_prompt = f"@code-reviewer please review the current changes in the repository. Context: {context_info}"
    
    # Create Claude options and run review
    options = create_claude_options()
    
    # Collect all messages and extract final assistant response
    all_messages = []
    async for message in query(prompt=review_prompt, options=options):
        all_messages.append(message)
    
    # Extract the final assistant message content (the actual review)
    final_review = ""
    for message in reversed(all_messages):
        if hasattr(message, 'content') and message.content:
            # Look for the last assistant message with actual content
            if hasattr(message.content[0], 'text'):
                final_review = message.content[0].text
                break
        elif isinstance(message, str):
            # Handle string messages
            final_review = message
            break
    
    # Output the results
    if output_format == 'text':
        output_content = final_review
    else:
        # Convert to GitLab JSON format
        findings = parse_text_review_to_gitlab_json(final_review)
        output_content = json.dumps(findings, indent=2)
    
    # Write to file or stdout
    if args.output:
        with open(args.output, 'w', encoding='utf-8') as f:
            f.write(output_content)
        print(f"Review output written to: {args.output}")
    else:
        print(output_content)


def cli_main():
    """CLI entry point for the drs command."""
    anyio.run(main)

if __name__ == "__main__":
    cli_main() 
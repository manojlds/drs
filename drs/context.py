"""Context detection and git command generation for DRS."""

import os
from enum import Enum


class OutputFormat(Enum):
    """Available output formats for code review."""
    TEXT = "text"
    GITLAB_JSON = "gitlab-json"
    AUTO = "auto"


def detect_context():
    """Detect comprehensive GitLab CI/CD environment context."""
    return {
        "is_ci": bool(os.getenv("CI")),
        "is_mr": os.getenv("CI_PIPELINE_SOURCE") == "merge_request_event",
        "mr_id": os.getenv("CI_MERGE_REQUEST_ID"),
        "source_branch": os.getenv("CI_MERGE_REQUEST_SOURCE_BRANCH_NAME"),
        "target_branch": os.getenv("CI_MERGE_REQUEST_TARGET_BRANCH_NAME"),
        "project_path": os.getenv("CI_PROJECT_PATH"),
        "commit_sha": os.getenv("CI_COMMIT_SHA"),
    }


def determine_review_context(args):
    """Determine review context and mode."""
    context = detect_context()

    if args.local:
        return "local", None

    if context["is_mr"] and context["mr_id"]:
        print(f"Detected GitLab CI/CD context. MR ID: {context['mr_id']}")
        return "mr", context["mr_id"]

    if args.mr_id:
        print(f"Local mode with MR ID: {args.mr_id}")
        return "mr", args.mr_id

    print("Local git diff mode")
    return "local", None


def get_git_commands_for_context(context_type, context_info):
    """Generate context-specific git commands for the subagent to execute."""
    if context_type == "local":
        return """
# Git commands for local development review:
git status
git diff --cached --name-only    # List staged files
git diff --name-only             # List unstaged files
git ls-files --others --exclude-standard  # List untracked files
git diff --cached                # Show staged changes
git diff                         # Show unstaged changes

# For untracked files, read their content directly using the Read tool
"""

    elif context_type == "mr_local":
        mr_id = context_info.get("mr_id")
        return f"""
# Git commands for local MR review:
git status
glab mr view {mr_id} --json      # Get MR metadata
glab mr diff {mr_id}             # Get full MR diff against target branch
"""

    elif context_type == "mr_ci":
        target_branch = context_info.get("target_branch", "main")
        source_branch = context_info.get("source_branch", "HEAD")
        return f"""
# Git commands for GitLab CI MR review:
git status
git diff origin/{target_branch}...HEAD --name-only    # List files changed in MR
git diff origin/{target_branch}...HEAD                # Show all MR changes

# This shows all commits in the MR, not just the latest commit
# Target branch: {target_branch}
# Source branch: {source_branch}
"""

    return "git status  # Default fallback"


def get_context_description(context_type, context_info):
    """Generate human-readable context description."""
    if context_type == "local":
        return "Local development changes (staged, unstaged, untracked files)"

    elif context_type == "mr_local":
        mr_id = context_info.get("mr_id", "unknown")
        return f"Local MR review for MR !{mr_id}"

    elif context_type == "mr_ci":
        mr_id = context_info.get("mr_id", "unknown")
        target_branch = context_info.get("target_branch", "main")
        source_branch = context_info.get("source_branch", "HEAD")
        return f"GitLab CI MR review for !{mr_id} ({source_branch} → {target_branch})"

    return f"Unknown context: {context_type}"


def get_detailed_context_info(raw_context_type, mr_id, context):
    """Determine specific context type and detailed context information."""
    if raw_context_type == "local":
        context_type = "local"
        context_info = {}
    elif raw_context_type == "mr" and context["is_ci"] and context["is_mr"]:
        # GitLab CI MR context
        context_type = "mr_ci"
        context_info = {
            "mr_id": context["mr_id"],
            "target_branch": context["target_branch"],
            "source_branch": context["source_branch"],
            "project_path": context["project_path"],
            "commit_sha": context["commit_sha"],
        }
    elif raw_context_type == "mr":
        # Local MR review using glab
        context_type = "mr_local"
        context_info = {"mr_id": mr_id}
    else:
        context_type = "local"
        context_info = {}

    return context_type, context_info

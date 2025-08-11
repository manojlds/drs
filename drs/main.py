"""DRS - Diff Review System CLI entry point."""

import argparse
import shutil
from pathlib import Path

import anyio

from .reviewer import run_review


def get_version():
    """Get version from package metadata."""
    try:
        from importlib.metadata import version

        return version("diff-review-system")
    except Exception:
        # Fallback for development mode - read from pyproject.toml
        try:
            import tomllib

            pyproject_path = Path(__file__).parent.parent / "pyproject.toml"
            with open(pyproject_path, "rb") as f:
                data = tomllib.load(f)
            return data["project"]["version"]
        except Exception:
            return "unknown"


def parse_cli_args():
    """Parse command line arguments."""
    version = get_version()
    parser = argparse.ArgumentParser(
        description=f"DRS - Diff Review System v{version}", prog="drs"
    )
    parser.add_argument("--version", action="version", version=f"drs {version}")
    subparsers = parser.add_subparsers(dest="command", help="Available commands")

    # Review command (default behavior)
    review_parser = subparsers.add_parser("review", help="Run code review (default)")
    review_parser.add_argument(
        "--mr-id", type=str, help="GitLab Merge Request ID to review"
    )
    review_parser.add_argument(
        "--format",
        type=str,
        choices=["text", "gitlab-json", "auto"],
        default="auto",
        help="Output format (default: auto)",
    )
    review_parser.add_argument(
        "--local",
        action="store_true",
        help="Force local git diff mode (ignore MR context)",
    )
    review_parser.add_argument(
        "-o", "--output", type=str, help="Output file path (default: stdout)"
    )
    review_parser.add_argument(
        "--full-review",
        action="store_true",
        help="Perform full codebase review even when no changes detected",
    )
    review_parser.add_argument(
        "--debug",
        action="store_true",
        help="Enable verbose debug logging and Claude CLI diagnostics",
    )

    # Init command
    init_parser = subparsers.add_parser(
        "init", help="Initialize DRS in current directory"
    )
    init_parser.add_argument(
        "--force",
        action="store_true",
        help="Overwrite existing code-reviewer.md if it exists",
    )

    # For backward compatibility, also add review args to main parser
    parser.add_argument("--mr-id", type=str, help="GitLab Merge Request ID to review")
    parser.add_argument(
        "--format",
        type=str,
        choices=["text", "gitlab-json", "auto"],
        default="auto",
        help="Output format (default: auto)",
    )
    parser.add_argument(
        "--local",
        action="store_true",
        help="Force local git diff mode (ignore MR context)",
    )
    parser.add_argument(
        "-o", "--output", type=str, help="Output file path (default: stdout)"
    )
    parser.add_argument(
        "--full-review",
        action="store_true",
        help="Perform full codebase review even when no changes detected",
    )
    parser.add_argument(
        "--debug",
        action="store_true",
        help="Enable verbose debug logging and Claude CLI diagnostics",
    )

    return parser.parse_args()


def init_command(force=False):
    """Initialize DRS configuration in the current directory."""
    # Get the path to the DRS package's .claude directory
    drs_package_dir = Path(__file__).parent.parent
    source_claude_dir = drs_package_dir / ".claude"
    source_agent_file = source_claude_dir / "agents" / "code-reviewer.md"

    target_claude_dir = Path.cwd() / ".claude"
    target_agents_dir = target_claude_dir / "agents"
    target_agent_file = target_agents_dir / "code-reviewer.md"

    if not source_agent_file.exists():
        print(f"Error: Source code-reviewer.md not found at {source_agent_file}")
        return 1

    # Create .claude directory if it doesn't exist
    if not target_claude_dir.exists():
        target_claude_dir.mkdir()
        print(f"✓ Created .claude directory at {target_claude_dir}")
    else:
        print(f"✓ .claude directory already exists at {target_claude_dir}")

    # Create agents directory if it doesn't exist
    if not target_agents_dir.exists():
        target_agents_dir.mkdir()
        print(f"✓ Created agents directory at {target_agents_dir}")

    # Check if code-reviewer.md already exists
    if target_agent_file.exists() and not force:
        print(f"Warning: code-reviewer.md already exists at {target_agent_file}")
        response = input("Do you want to overwrite it? (y/N): ").lower().strip()
        if response != "y":
            print(
                "Initialization cancelled. Use --force to overwrite without prompting."
            )
            return 0

    try:
        shutil.copy2(source_agent_file, target_agent_file)
        print(f"✓ Copied code-reviewer.md to {target_agent_file}")
        print("✓ DRS initialization complete!")
        print("\nNext steps:")
        print("- Run 'drs --local' to review local changes")
        print("- Run 'drs --mr-id <ID>' to review a GitLab merge request")
        return 0
    except Exception as e:
        print(f"Error copying code-reviewer.md: {e}")
        return 1


async def main():
    """Main async function that orchestrates the code review."""
    args = parse_cli_args()

    # Handle init command
    if args.command == "init":
        import sys

        sys.exit(init_command(getattr(args, "force", False)))

    # Enable SDK and CLI debug/verbose output when requested
    if getattr(args, "debug", False):
        import logging
        import os

        logging.basicConfig(level=logging.DEBUG)
        # Common Node-style debug env and a generic VERBOSE toggle; harmless if unused
        os.environ.setdefault("DEBUG", "*")
        os.environ.setdefault("VERBOSE", "true")
    await run_review(args)


def cli_main():
    """CLI entry point for the drs command."""
    anyio.run(main)


if __name__ == "__main__":
    cli_main()

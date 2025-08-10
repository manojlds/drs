"""DRS - Diff Review System CLI entry point."""

import argparse

import anyio

from .reviewer import run_review


def parse_cli_args():
    """Parse command line arguments."""
    parser = argparse.ArgumentParser(description="DRS - Diff Review System")
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
    return parser.parse_args()


async def main():
    """Main async function that orchestrates the code review."""
    args = parse_cli_args()
    await run_review(args)


def cli_main():
    """CLI entry point for the drs command."""
    anyio.run(main)


if __name__ == "__main__":
    cli_main()

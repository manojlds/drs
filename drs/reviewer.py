"""Main code review orchestration logic for DRS."""

from .claude_integration import (
    create_review_prompt,
    extract_final_assistant_message,
    run_code_review,
    validate_and_format_json,
)
from .context import (
    check_for_changes,
    detect_context,
    determine_review_context,
    get_context_description,
    get_detailed_context_info,
    get_git_commands_for_context,
    get_no_changes_message,
)


async def run_review(args):
    """Run the complete code review process."""
    # Determine review context
    raw_context_type, mr_id = determine_review_context(args)
    context = detect_context()

    # Get detailed context information
    context_type, context_info = get_detailed_context_info(
        raw_context_type, mr_id, context
    )

    # Determine output format
    output_format = args.format
    if output_format == "auto":
        output_format = "gitlab-json" if context["is_ci"] else "text"

    print(f"Output format: {output_format}")
    if getattr(args, "debug", False):
        print("Debug mode: enabled")

    # Check for changes unless --full-review is specified
    if not args.full_review:
        has_changes = check_for_changes(context_type, context_info)
        if not has_changes:
            print("No changes detected.")
            no_changes_output = get_no_changes_message(
                context_type, context_info, output_format
            )

            # Write to file or stdout
            if args.output:
                with open(args.output, "w", encoding="utf-8") as f:
                    f.write(no_changes_output)
                print(f"No changes message written to: {args.output}")
            else:
                print(no_changes_output)
            return

    # Get context description and git commands
    context_description = get_context_description(context_type, context_info)
    git_commands = get_git_commands_for_context(
        context_type, context_info, args.full_review
    )

    review_mode = "Full codebase review" if args.full_review else context_description
    print(f"Review context: {review_mode}")
    print("\n" + "=" * 60)
    print(f"STARTING CODE REVIEW - {review_mode}")
    print("=" * 60 + "\n")

    # Create review prompt and run code review
    review_prompt = create_review_prompt(
        context_description, git_commands, output_format
    )

    all_messages = await run_code_review(
        review_prompt, debug=getattr(args, "debug", False)
    )

    # Extract final review content
    final_review = extract_final_assistant_message(all_messages)

    # Format output based on requested format
    if output_format == "text":
        output_content = final_review
    else:
        # Validate and format JSON output
        output_content = validate_and_format_json(final_review)

    # Write to file or stdout
    if args.output:
        with open(args.output, "w", encoding="utf-8") as f:
            f.write(output_content)
        print(f"Review output written to: {args.output}")
        if output_format == "gitlab-json":
            print("GitLab Code Quality JSON format generated successfully.")
    else:
        if output_format == "gitlab-json":
            print("GitLab Code Quality JSON:")
        print(output_content)

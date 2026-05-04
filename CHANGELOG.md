# Changelog

All notable changes to DRS are documented in this file.

## 3.3.1 - 2026-05-04

### Changed

- Remove obsolete Vaibhav/Ralph project artifacts and stale repository references.
- Remove direct `@anthropic-ai/sdk` dependency and rely on Pi's transitive SDK dependency.

### Fixed

- Fail review execution when configured skills are missing, with an explicit error that includes searched skill paths.

## 3.3.0 - 2026-05-03

### Added

- Add opt-in `Fix in Cursor` links to posted review summary and inline issue comments.
- Add `review.cursorFixLinks` config with optional `workspace` routing.
- Add `--fix-in-cursor` and `--skip-fix-in-cursor` CLI overrides for review and comment-posting flows.

### Changed

- Use Cursor's HTTPS prompt deeplink bridge so hosted PR/MR platforms preserve review comment links.
- Enable Cursor fix links for this repository's DRS config.
- Switch this repository's review and description models to `opencode-go/glm-5`.

### Fixed

- Make `post-comments` honor configured Cursor fix link defaults and workspace settings.
- Sanitize additional hidden Unicode separators before embedding review issue text in Cursor prompts.

# NPM Publishing Setup

This document describes the npm publishing setup for this project.

## What's Been Configured

### 1. Package.json Updates
- Added `prepublishOnly` script to ensure build runs before publishing
- Added `files` field to explicitly control what gets published
- Added repository, bugs, and homepage URLs
- Fixed `@gitbeaker/node` version (changed from 39.0.0 to 35.8.1)

### 2. .npmignore
Created `.npmignore` file to exclude:
- Source TypeScript files (only dist/ is published)
- Test files
- Config files
- Development files
- CI/CD files
- Documentation that shouldn't be published

### 3. GitHub Actions Workflows

#### publish.yml
- Triggers on version tags (v*)
- Can be manually triggered
- Runs linter and tests before publishing
- Publishes to npm with provenance
- Requires `NPM_TOKEN` secret to be set in GitHub

#### ci.yml
- Runs on push to main and pull requests
- Tests on Node.js 20 and 22
- Runs linter, tests, and build
- Validates package can be packed

## How to Publish

### Method 1: Automated (Recommended)

1. Update version in package.json:
   ```bash
   npm version patch  # or minor, or major
   ```

2. Push the tag:
   ```bash
   git push origin v1.0.1  # Use the version created
   ```

3. GitHub Actions will automatically publish to npm

### Method 2: Manual

1. Ensure you're logged into npm:
   ```bash
   npm login
   ```

2. Run the build:
   ```bash
   npm run build
   ```

3. Publish:
   ```bash
   npm publish --access public
   ```

## Setup Requirements

### GitHub Secrets
Add `NPM_TOKEN` to GitHub repository secrets:
1. Go to GitHub repository → Settings → Secrets and variables → Actions
2. Click "New repository secret"
3. Name: `NPM_TOKEN`
4. Value: Your npm access token (create at https://www.npmjs.com/settings/{username}/tokens)
   - Token type: "Automation" or "Publish"
   - Make sure it has publish permissions

### NPM Package Access
The package is scoped (`@drs/gitlab-review-bot`), so you need to ensure:
- You have access to publish to the `@drs` scope on npm
- The package is set to public access (handled by `--access public` flag)

## Known Issues to Fix

The following TypeScript compilation errors need to be fixed before the package can be published:

1. **Missing YAML dependency**: Add `yaml` package to dependencies
2. **@gitbeaker API changes**: The codebase uses old @gitbeaker APIs that don't exist in v35
   - `MergeRequestSchema` doesn't exist
   - `MergeRequestDiffSchema` doesn't exist
   - `allDiffs` method doesn't exist
3. **Type mismatches**: Several type conversion issues in gitlab/client.ts
4. **OpenCode client type issues**: Type conflicts in opencode/client.ts

### Suggested Fixes

```bash
# Add missing dependency
npm install yaml

# Consider upgrading to @gitbeaker/rest (the successor package)
npm install @gitbeaker/rest
```

Then update the import statements and API calls to match the new @gitbeaker API.

## Package Contents

When published, the package will include:
- `dist/` - Compiled JavaScript and TypeScript declarations
- `README.md` - Project documentation
- `LICENSE` - Apache-2.0 license
- `.opencode/` - OpenCode agent definitions
- `package.json` - Package metadata

## Testing Before Publishing

Always test the package before publishing:

```bash
# Build the project
npm run build

# Create a test pack (doesn't publish)
npm pack --dry-run

# Or create actual tarball to inspect
npm pack
tar -tzf drs-gitlab-review-bot-*.tgz
```

# NPM Publishing Setup

This document describes the npm publishing setup for this project.

## ✅ What's Been Configured

### 1. Package.json Updates
- Added `prepublishOnly` script to ensure build runs before publishing
- Added `files` field to explicitly control what gets published (dist/, README.md, LICENSE, .opencode/)
- Added repository, bugs, and homepage URLs
- Package name: `@drs/gitlab-review-bot`
- Version: `1.0.0` (ready for initial release)

### 2. .npmignore
Created `.npmignore` file to exclude:
- Source TypeScript files (only dist/ is published)
- Test files and development configs
- CI/CD files and documentation
- Environment files and IDE settings

### 3. GitHub Actions Workflows

#### 📦 publish.yml - Automated Publishing
- **Triggers**: When you push a version tag (e.g., `v1.0.0`, `v1.0.1`)
- **Process**: Runs linter → tests → build → publish to npm
- **Features**:
  - Publishes with provenance for supply chain security
  - Sets package to public access automatically
  - Can also be manually triggered via GitHub Actions UI

#### 🧪 ci.yml - Continuous Integration
- **Triggers**: Push to main or any pull request
- **Tests**: Node.js versions 20 and 22
- **Validates**: Linting, tests, build, and package integrity

## 🚀 How to Publish (Step-by-Step)

### One-Time Setup (Do This First!)

This project uses **npm Trusted Publishing** (via OIDC) - a more secure method that doesn't require long-lived tokens!

#### 1. Configure Trusted Publishing on npm

On your **first publish**, you need to configure the package for trusted publishing:

**Option A: First-time publish with manual token (one-time only)**
```bash
# 1. Create a temporary token on npmjs.com
#    - Go to https://www.npmjs.com → Profile → Access Tokens
#    - Create "Publish" token (short-lived)

# 2. Publish first version manually
npm login
npm publish --access public

# 3. Configure trusted publishing on npm
#    - Go to https://www.npmjs.com/package/@drs/gitlab-review-bot/access
#    - Under "Publishing access", click "Configure trusted publishers"
#    - Add GitHub Actions publisher:
#      * Provider: GitHub Actions
#      * Repository owner: manojlds
#      * Repository name: drs
#      * Workflow name: publish.yml
#      * Environment (optional): leave empty
```

**Option B: Configure before first publish (if you have npm organization admin rights)**
```bash
# 1. Go to https://www.npmjs.com/package/@drs/gitlab-review-bot
# 2. If package doesn't exist yet, you'll need to publish manually first (see Option A)
```

#### 2. Verify NPM Scope Access
The package is scoped as `@drs/gitlab-review-bot`. Ensure:
- You have publish access to the `@drs` scope on npm
- Or update the package name in `package.json` to use your own scope

#### 3. That's It!
No GitHub secrets needed! Trusted publishing uses OIDC tokens automatically.

### Publishing a New Version (Every Release)

#### Automated Publishing (Recommended)
```bash
# 1. Ensure you're on main branch and it's clean
git checkout main
git pull origin main

# 2. Bump version and create a git tag
npm version patch   # 1.0.0 → 1.0.1 (bug fixes)
# or
npm version minor   # 1.0.0 → 1.1.0 (new features)
# or
npm version major   # 1.0.0 → 2.0.0 (breaking changes)

# 3. Push the tag (this triggers automated publishing!)
git push --follow-tags

# 4. Watch the GitHub Actions run
# Go to: https://github.com/manojlds/drs/actions
# The publish workflow will automatically run and publish to npm
```

**Yes, publishing happens automatically when you push a version tag!** The tag format is `vX.Y.Z` (e.g., `v1.0.1`).

#### Manual Publishing (Alternative)
```bash
# 1. Login to npm
npm login

# 2. Update version
npm version patch

# 3. Build and publish
npm run build
npm publish --access public

# 4. Push the tag to GitHub
git push --follow-tags
```

## 📦 Package Contents

When published to npm, the package will include:
- ✅ `dist/` - Compiled JavaScript and TypeScript declarations (~44 KB)
- ✅ `README.md` - Project documentation
- ✅ `LICENSE` - Apache-2.0 license
- ✅ `.opencode/` - OpenCode agent definitions
- ✅ `package.json` - Package metadata

**Total package size**: ~44 KB (220 KB unpacked)

## 🧪 Testing Before Publishing

Always test the package locally before publishing:

```bash
# 1. Clean build
rm -rf dist node_modules
npm install
npm run build

# 2. Run tests and linter
npm test
npm run lint

# 3. Dry-run pack to see what will be published
npm pack --dry-run

# 4. Create actual tarball for inspection
npm pack
tar -tzf drs-gitlab-review-bot-*.tgz | less

# 5. Test installation locally
npm install -g ./drs-gitlab-review-bot-*.tgz
drs --help
npm uninstall -g @drs/gitlab-review-bot
```

## 🔍 Verification After Publishing

After publishing, verify the package:

```bash
# View package info on npm
npm view @drs/gitlab-review-bot

# Test installation from npm
npm install -g @drs/gitlab-review-bot
drs --help
drs init

# Check specific version
npm view @drs/gitlab-review-bot versions
```

## 🎯 Quick Reference

### When Does Publishing Happen?

**Automatic Publishing**: When you push a git tag starting with `v`
```bash
npm version patch        # Creates tag like v1.0.1
git push --follow-tags   # Triggers GitHub Actions workflow
```

**Manual Trigger**: Via GitHub Actions UI
1. Go to Actions tab → "Publish to npm" workflow
2. Click "Run workflow"
3. Select branch and optionally specify version

### Common Commands

```bash
# Version bumps (also creates git tag)
npm version patch    # 1.0.0 → 1.0.1 (bug fixes)
npm version minor    # 1.0.0 → 1.1.0 (new features)
npm version major    # 1.0.0 → 2.0.0 (breaking changes)

# Pre-release versions
npm version prepatch # 1.0.0 → 1.0.1-0
npm version preminor # 1.0.0 → 1.1.0-0
npm version premajor # 1.0.0 → 2.0.0-0

# Custom version
npm version 1.2.3

# Push with tags
git push --follow-tags
```

## 🔐 Why Trusted Publishing?

**Security Benefits:**
- ✅ No long-lived tokens to manage or rotate
- ✅ No secrets stored in GitHub
- ✅ Automatic provenance generation (supply chain security)
- ✅ Each publish is cryptographically linked to the exact commit
- ✅ Impossible to publish from outside the configured repository

**How it works:**
1. GitHub Actions generates a short-lived OIDC token
2. npm verifies the token came from your configured repository
3. Publish succeeds only if the OIDC token is valid
4. Provenance metadata is automatically added to the package

## ❗ Troubleshooting

### "npm publish failed with 403"
- **Cause**: Trusted publishing not configured or no access to `@drs` scope
- **Fix**:
  1. Verify trusted publisher is configured on npmjs.com package page
  2. Check you have publish rights: `npm access ls-packages`
  3. Ensure repository owner/name match exactly in npm config

### "No matching version found"
- **Cause**: Dependency version doesn't exist
- **Fix**: Run `npm install` to update package-lock.json

### "Build failed in GitHub Actions"
- **Cause**: Tests or linter failing
- **Fix**:
  1. Run locally: `npm test && npm run lint`
  2. Fix any errors
  3. Push fixes before tagging

### "Package not found after publishing"
- **Wait**: NPM registry can take 1-2 minutes to propagate
- **Check**: Visit https://www.npmjs.com/package/@drs/gitlab-review-bot

## 📚 Resources

- [NPM Publishing Docs](https://docs.npmjs.com/cli/v9/commands/npm-publish)
- [GitHub Actions Docs](https://docs.github.com/en/actions)
- [Semantic Versioning](https://semver.org/)
- [Package Provenance](https://docs.npmjs.com/generating-provenance-statements)

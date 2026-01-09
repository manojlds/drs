# NPM Publishing Setup Checklist

Use this checklist to set up npm publishing for the first time.

**Note:** This project uses **npm Trusted Publishing** (OIDC) - no GitHub secrets needed! 🎉

## ☑️ Pre-Publish Checklist

### 1. NPM Account Setup
- [ ] Create account on [npmjs.com](https://www.npmjs.com/signup) (if you don't have one)
- [ ] Verify email address
- [ ] Enable 2FA (recommended for security)

### 2. NPM Scope/Package Name
- [ ] Package name is: `@drs/gitlab-review-bot`
- [ ] Verify you have publish access to the `@drs` scope:
  ```bash
  npm login
  npm access ls-packages
  ```
- [ ] If no access: Either:
  - Request access to `@drs` scope from owner
  - OR change package name in `package.json` to your own scope (e.g., `@yourname/gitlab-review-bot`)

### 3. ~~GitHub Repository Setup~~ ❌ NOT NEEDED!
With trusted publishing, you don't need to store any npm tokens in GitHub! Skip this step.

### 4. Verify Build
- [ ] Build passes locally:
  ```bash
  npm install
  npm run build
  npm test
  npm run lint
  ```
- [ ] Package looks correct:
  ```bash
  npm pack --dry-run
  ```

## 🚀 First Publish Steps

### Step 1: Manual First Publish (one-time only)

For the first publish, do it manually to create the package on npm:

```bash
# 1. Login to npm
npm login

# 2. Build the project
npm run build

# 3. Publish manually (one time only)
npm publish --access public

# This creates the package on npm so you can configure trusted publishing
```

### Step 2: Configure Trusted Publishing on npm

After the first manual publish:

```bash
# 1. Go to your package page on npm
open https://www.npmjs.com/package/@drs/gitlab-review-bot/access

# 2. Under "Publishing access", find "Trusted publishers"

# 3. Click "Add trusted publisher"

# 4. Fill in:
#    - Provider: GitHub Actions
#    - Repository owner: manojlds
#    - Repository name: drs
#    - Workflow filename: publish.yml
#    - Environment name: (leave empty)

# 5. Save
```

### Step 3: Test Automated Publishing

```bash
# 1. Ensure you're on main branch
git checkout main
git pull origin main

# 2. Create next version tag
npm version 1.0.1

# 3. Push the tag to trigger automated publishing
git push --follow-tags

# 4. Watch the GitHub Actions workflow
# Visit: https://github.com/manojlds/drs/actions
# The "Publish to npm" workflow will publish automatically!

# 5. Verify publication
npm view @drs/gitlab-review-bot

# You should see provenance information showing it was published from GitHub Actions
```

## 📋 Subsequent Releases

For future releases, simply:

```bash
npm version patch   # or minor, or major
git push --follow-tags
```

GitHub Actions handles everything else automatically!

## ❌ If Something Goes Wrong

### Build Fails
```bash
# Check what's wrong
npm run build
npm test
npm run lint

# Fix the issues, then retry
```

### Can't Publish to @drs Scope
```bash
# Option 1: Change package name to your scope
# Edit package.json, change: "@drs/gitlab-review-bot" to "@yourname/gitlab-review-bot"

# Option 2: Publish without scope (if name is available)
# Edit package.json, change: "@drs/gitlab-review-bot" to "gitlab-review-bot"
```

### GitHub Actions Workflow Fails with 403
- **Most common cause**: Trusted publishing not configured on npmjs.com
- **Fix**: Complete Step 2 above (Configure Trusted Publishing)
- Verify the repository owner/name exactly match: `manojlds/drs`
- Check workflow filename is exactly: `publish.yml`

### Want to see provenance information?
```bash
# After publishing with trusted publishing, view the package
npm view @drs/gitlab-review-bot

# You'll see attestations showing:
# - Which GitHub Actions workflow published it
# - The exact commit SHA
# - Cryptographic signatures proving authenticity
```

## 📚 Next Steps After First Publish

- [ ] Update README badges with npm version badge
- [ ] Test installation: `npm install -g @drs/gitlab-review-bot`
- [ ] Create GitHub release notes for the version
- [ ] Announce the release!

---

**Need help?** See [PUBLISHING_SETUP.md](./PUBLISHING_SETUP.md) for detailed instructions.

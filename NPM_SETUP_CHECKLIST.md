# NPM Publishing Setup Checklist

Use this checklist to set up npm publishing for the first time.

## ☑️ Pre-Publish Checklist

### 1. NPM Account Setup
- [ ] Create account on [npmjs.com](https://www.npmjs.com/signup) (if you don't have one)
- [ ] Verify email address
- [ ] Enable 2FA (recommended for security)

### 2. NPM Access Token
- [ ] Go to https://www.npmjs.com → Profile → Access Tokens
- [ ] Click "Generate New Token" → "Classic Token"
- [ ] Select "Automation" type
- [ ] Copy the token (starts with `npm_...`)
- [ ] **Important**: Save it securely - you won't see it again!

### 3. NPM Scope/Package Name
- [ ] Decide on package name: Currently `@drs/gitlab-review-bot`
- [ ] If using `@drs` scope: Verify you have access to this scope
  ```bash
  npm access ls-packages
  ```
- [ ] If no access: Either:
  - Request access to `@drs` scope from owner
  - OR change package name in `package.json` to your own scope (e.g., `@yourname/gitlab-review-bot`)

### 4. GitHub Repository Setup
- [ ] Add `NPM_TOKEN` secret to GitHub:
  1. Go to https://github.com/manojlds/drs/settings/secrets/actions
  2. Click "New repository secret"
  3. Name: `NPM_TOKEN`
  4. Value: [paste your npm token]
  5. Click "Add secret"

### 5. Verify Build
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

Once the above checklist is complete:

```bash
# 1. Ensure you're on main branch
git checkout main
git pull origin main

# 2. Verify everything works
npm run build
npm test

# 3. Create first version tag
npm version 1.0.0

# 4. Push the tag to trigger publishing
git push --follow-tags

# 5. Watch the GitHub Actions workflow
# Visit: https://github.com/manojlds/drs/actions
# The "Publish to npm" workflow should start automatically

# 6. Verify publication (after workflow completes)
npm view @drs/gitlab-review-bot
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

### Workflow Fails with 403
- Check NPM_TOKEN is correctly set in GitHub secrets
- Verify token hasn't expired
- Regenerate token if needed and update GitHub secret

## 📚 Next Steps After First Publish

- [ ] Update README badges with npm version badge
- [ ] Test installation: `npm install -g @drs/gitlab-review-bot`
- [ ] Create GitHub release notes for the version
- [ ] Announce the release!

---

**Need help?** See [PUBLISHING_SETUP.md](./PUBLISHING_SETUP.md) for detailed instructions.

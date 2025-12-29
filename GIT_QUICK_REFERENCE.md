# Git Quick Reference for Silo

## Current Branch Status
- ✅ `main` - Production branch
- ✅ `develop` - Development branch

## Quick Commands

### Daily Workflow

```bash
# Start working on a new feature
git checkout develop
git pull origin develop
git checkout -b feature/your-feature-name

# Make changes, commit often
git add .
git commit -m "feat(scope): description of change"
git push origin feature/your-feature-name

# When done, merge to develop
git checkout develop
git pull origin develop
git merge --no-ff feature/your-feature-name
git push origin develop
git branch -d feature/your-feature-name
```

### Commit Message Examples

```bash
# Feature
git commit -m "feat(profiles): add avatar upload functionality"

# Bug fix
git commit -m "fix(sidebar): resolve event listener memory leak"

# Documentation
git commit -m "docs: update README with installation steps"

# Refactoring
git commit -m "refactor(main): extract view creation logic"

# Chore (dependencies, build, etc.)
git commit -m "chore(deps): update Electron to v39.2.3"
```

### Release Process

```bash
# 1. Create release branch
git checkout develop
git checkout -b release/1.1.0

# 2. Update version
npm version 1.1.0 --no-git-tag-version
git add package.json package-lock.json
git commit -m "chore(release): bump version to 1.1.0"

# 3. Update CHANGELOG.md
# Edit CHANGELOG.md to document all changes
git add CHANGELOG.md
git commit -m "docs(changelog): update for v1.1.0 release"

# 4. Merge to main and tag
git checkout main
git merge --no-ff release/1.1.0
git tag -a v1.1.0 -m "Release v1.1.0"
git push origin main --tags

# 5. Merge back to develop
git checkout develop
git merge --no-ff release/1.1.0
git push origin develop

# 6. Cleanup
git branch -d release/1.1.0
```

### Hotfix (Urgent Production Fix)

```bash
# 1. Create hotfix from main
git checkout main
git checkout -b hotfix/1.0.1

# 2. Fix and commit
# Make your changes
git add .
git commit -m "fix(critical): describe the urgent fix"

# 3. Update version
npm version patch --no-git-tag-version
git add package.json package-lock.json
git commit -m "chore(release): bump version to 1.0.1"

# 4. Merge to main and tag
git checkout main
git merge --no-ff hotfix/1.0.1
git tag -a v1.0.1 -m "Hotfix v1.0.1"
git push origin main --tags

# 5. Merge to develop
git checkout develop
git merge --no-ff hotfix/1.0.1
git push origin develop

# 6. Cleanup
git branch -d hotfix/1.0.1
```

### Useful Commands

```bash
# View commit history
git log --oneline --graph --all -20

# View changes not yet committed
git status
git diff

# View changes in a specific commit
git show <commit-hash>

# Switch branches
git checkout develop
git checkout main

# Create and switch to new branch
git checkout -b feature/new-feature

# Delete branch
git branch -d feature/completed-feature

# Push branch to remote
git push -u origin feature/new-feature

# Sync with remote
git fetch origin
git pull origin develop
```

## Branch Protection (Future)

When collaborating with others, consider enabling branch protection on GitHub:
- Require pull requests for `main` and `develop`
- Require review before merging
- Require status checks to pass
- Prevent force pushes

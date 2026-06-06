# Contributing to Silo

## Git Workflow

Silo follows a simplified Git Flow workflow suitable for a solo developer project that may grow into a team project.

### Branch Structure

- **`main`** - Production-ready code. Always stable and deployable.
- **`develop`** - Integration branch for features. Latest development work.
- **`feature/*`** - New features or enhancements
- **`bugfix/*`** - Bug fixes for develop branch
- **`hotfix/*`** - Urgent fixes for production (main branch)
- **`release/*`** - Release preparation branches

### Workflow

#### Starting a New Feature

```bash
# Ensure you're on the latest develop
git checkout develop
git pull origin develop

# Create a feature branch
git checkout -b feature/multi-profile-support
```

#### Working on a Feature

```bash
# Make commits with descriptive messages
git add .
git commit -m "Add profile switcher UI to settings view"

# Push to remote periodically
git push origin feature/multi-profile-support
```

#### Completing a Feature

```bash
# Ensure branch is up to date
git checkout develop
git pull origin develop
git checkout feature/multi-profile-support
git rebase develop  # or merge develop into feature branch

# Merge into develop
git checkout develop
git merge --no-ff feature/multi-profile-support
git push origin develop

# Delete feature branch (optional)
git branch -d feature/multi-profile-support
git push origin --delete feature/multi-profile-support
```

#### Bug Fixes

```bash
# Create bugfix branch from develop
git checkout develop
git checkout -b bugfix/fix-avatar-upload-crash

# Fix, commit, and merge back to develop
git add .
git commit -m "Fix crash when uploading large profile images"
git checkout develop
git merge --no-ff bugfix/fix-avatar-upload-crash
git push origin develop
```

#### Hotfixes (Urgent Production Fixes)

```bash
# Create hotfix from main
git checkout main
git checkout -b hotfix/1.0.1

# Fix and commit
git add .
git commit -m "Fix critical session persistence bug"

# Merge to both main and develop
git checkout main
git merge --no-ff hotfix/1.0.1
git tag -a v1.0.1 -m "Hotfix: session persistence"
git push origin main --tags

git checkout develop
git merge --no-ff hotfix/1.0.1
git push origin develop

# Delete hotfix branch
git branch -d hotfix/1.0.1
```

#### Releases

```bash
# Create release branch from develop
git checkout develop
git checkout -b release/1.1.0

# Update version numbers, changelog, etc.
npm version 1.1.0 --no-git-tag-version
git add package.json package-lock.json
git commit -m "Bump version to 1.1.0"

# Test thoroughly, fix any bugs in release branch
# When ready, merge to main and develop
git checkout main
git merge --no-ff release/1.1.0
git tag -a v1.1.0 -m "Release v1.1.0"
git push origin main --tags

git checkout develop
git merge --no-ff release/1.1.0
git push origin develop

# Delete release branch
git branch -d release/1.1.0
```

## Commit Message Guidelines

Follow conventional commits format:

```
<type>(<scope>): <subject>

<body>

<footer>
```

### Types
- **feat**: New feature
- **fix**: Bug fix
- **docs**: Documentation changes
- **style**: Code style changes (formatting, no logic change)
- **refactor**: Code refactoring
- **test**: Adding or updating tests
- **chore**: Maintenance tasks (dependencies, build config)
- **perf**: Performance improvements

### Examples

```
feat(profiles): add custom avatar upload functionality

- Replace Google profile picture extraction with user uploads
- Add file picker dialog for image selection
- Display Material Icons account_circle as default
- Update profile manager to store avatarPath instead of avatarUrl

Closes #12
```

```
fix(sidebar): resolve MaxListenersExceededWarning on profile switch

Added cleanup of resize listener when window is closed to prevent
accumulation of event listeners during profile switching.
```

```
chore(deps): update Electron to v39.2.3
```

## Version Numbering

Silo follows [Semantic Versioning](https://semver.org/):

**MAJOR.MINOR.PATCH** (e.g., 1.2.3)

- **MAJOR**: Breaking changes, incompatible API changes
- **MINOR**: New features, backward-compatible
- **PATCH**: Bug fixes, backward-compatible
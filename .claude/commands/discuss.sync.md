---
description: Sync commits from 001-opentelemetry-support to feat/opentelemetry-mvp branch
---

I need help syncing commits between two branches in my Bun fork:

- **Source branch**: `001-opentelemetry-support` (in ~/github/bun-fork)
- **Target branch**: `feat/opentelemetry-mvp` (in ~/github/worktree/bun)

## Process

### 1. Check for new commits

First, show me what needs syncing:

```bash
cd ~/github/worktree/bun && git log --oneline feat/opentelemetry-mvp..001-opentelemetry-support
```

The output will show ALL commits, including duplicates (cherry-picked commits have different hashes). To see only GENUINELY NEW commits, filter by recent date:

```bash
git log --oneline 001-opentelemetry-support --since="2025-10-29 01:30:00" | head -20
```

### 2. Identify commits to skip

**Skip any commits with these markers in the message:**

- `[SKIP-MVP]`
- `[SPECS-ONLY]`
- `[NO-PR]`
- `[NO-CONTRIB]`
- `[DO NOT CHERRY-PICK]`
- Any variation clearly indicating it should not go to MVP

**Why?** These commits often contain specs/, documentation, or temporary files that shouldn't bloat the upstream PR.

### 3. Cherry-pick the commits

For individual commits:

```bash
cd ~/github/worktree/bun
git cherry-pick <commit-hash>
```

For multiple commits (list them explicitly to skip marked ones):

```bash
git cherry-pick <hash1> <hash2> <hash3> ...
```

**Handling conflicts:**

- If cherry-pick fails with conflict, check if it's a duplicate:
  ```bash
  git log --grep="<commit-message-text>"
  ```
- If duplicate, skip:
  ```bash
  git cherry-pick --skip
  ```
- If real conflict, abort and notify me:
  ```bash
  git cherry-pick --abort
  ```

### 4. Verify no unwanted files

Ensure `specs/` directory wasn't accidentally brought back:

```bash
cd ~/github/worktree/bun && ls -la specs/ 2>&1 || echo "✅ specs/ not present (good)"
```

### 5. Push the synced branch

```bash
cd ~/github/worktree/bun && git push -f origin feat/opentelemetry-mvp
```

### 6. Provide sync summary

After syncing, provide a summary in this format:

```
🚀 Sync Complete!

New commits synced: X
- <hash> - <commit message>
- <hash> - <commit message>

Commits skipped: Y
- <hash> - <commit message> [reason: SKIP-MVP marker]

Verification:
✅ specs/ still absent
✅ Push successful

Key changes:
- [bullet point of important fixes/features]
```

## Goal

Keep the `feat/opentelemetry-mvp` branch in sync with my working `001-opentelemetry-support` branch without manually cherry-picking each commit or accidentally copying temporary/spec files.

## Context

## $ARGUMENTS

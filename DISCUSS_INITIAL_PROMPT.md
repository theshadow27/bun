# PR Review Comment Management

## Context

Working on PR https://github.com/oven-sh/bun/pull/23798 (branch: `feat/opentelemetry-server-hooks`). Use `discuss.ts` to manage automated code review comments systematically.

## Tool Overview

`discuss.ts` features:

- Fetches and tracks PR review comments in SQLite
- Resolves threads directly on GitHub (source of truth)
- Manages replies, snoozing, and notes
- Integrates via `gh api` (REST + GraphQL)

**Read detailed guides:**

- `DISCUSS_WORKFLOW.md` - Complete workflow documentation
- `DISCUSS_GITHUB_RESOLUTION.md` - GitHub integration details

## Essential Commands

```bash
# Sync with GitHub first
bun discuss.ts fetch

# View pending work
bun discuss.ts pending
bun discuss.ts pending --priority critical
bun discuss.ts pending --snoozed  # Include snoozed items

# Examine comment
bun discuss.ts show <id>

# Reply (auto-snoozes)
bun discuss.ts reply <id> "Your response"

# Resolve on GitHub
bun discuss.ts resolve <id> <commit-hash>

# Track progress
bun discuss.ts stats
```

## Workflow

1. **Sync** - Run `bun discuss.ts fetch` to get latest GitHub state
2. **Check pending** - `bun discuss.ts pending --priority critical`
3. **Review comment** - `bun discuss.ts show <id>`
4. **Reply or fix** - Explain reasoning; don't silently fix
5. **Resolve** - After fixing and testing and committing: `bun discuss.ts resolve <id> <commit>`
6. **Batch** - Commit 1-3 comments per commit, only files that changed. DO NOT PUSH
7. **Work priority order** - Critical → Major → Minor → Trivial
8. **Push at the End** - Only push once all comments are resolved

## Comment States

- **Pending** - Needs attention now
- **Snoozed** 😴 - Waiting for bot response (auto after reply)
- **Outdated** ⚠️ - Code changed since comment (GitHub marks automatically)
- **Resolved** ✅ - Done and marked on GitHub

## Best Practices

### Handling Comments

- **Be precise** - Cite code/specs when correcting the bot
- **Reply, don't ignore** - Explain your reasoning to the bot
- **Check for duplicates** - Use SQLite queries to find related issues
- **Skip outdated** - If marked `⚠️ OUTDATED`, code already changed
- **Reference discussions** - Link to previous conversations for duplicates
- **Commit messages reference comments** - including IDs so the bot can find them

### Resolution

- **Test before resolving** - Verify fix works first
- **Use commit hashes** - Include actual commit in resolve command
- **Batch commits** - Avoid rate limits by pushing multiple commits together
- **Let bot respond** - Check if bot acknowledged before resolving

### Bot Behavior

- **"Hopping back into my burrow"** - Bot accepted your explanation
- **Pedantic responses** - Sometimes explain "this is a design decision"
- **Automated rate limits** - Wait 15 minutes if you hit review rate limit

## Quick Queries

```bash
# Find duplicates by keyword
sqlite3 discuss.sqlite "SELECT id, path, body FROM comments WHERE body LIKE '%keyword%' AND github_resolved = 0"

# View all critical issues
bun discuss.ts pending --severity critical
```

## Getting Started

```bash
bun discuss.ts fetch
bun discuss.ts pending
bun discuss.ts show <id-from-list>
```

Work through issues systematically, starting with critical severity.

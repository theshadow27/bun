---
description: discuss.ts PR Review Comment Management
---

# PR Review Comment Management

We are working on cleanup of PR https://github.com/oven-sh/bun/pull/24063 , where we have implemented opentelemetry in oven-sh/bun. You will use the `bun discuss.ts` tool to manage automated code review comments systematically.

## Tool Overview

`discuss.ts` features:

- Fetches and tracks PR review comments in SQLite
- Resolves threads directly on GitHub (source of truth)
- Manages replies, snoozing, and notes
- Integrates via `gh api` (REST + GraphQL)

## Workflow

1. **Sync** - Run `bun discuss.ts fetch` to get latest GitHub state

- **Work priority order** - Critical → Major → Minor → Trivial

2. **Review comment** - `bun discuss.ts show <id>`
3. **Verify** - Always check the state of the issue on disk; commits are pushed asynchronously and things might have been already resolved.

- **Delegate**: Launch a Task to critically consider the accuracy of the comment, verify the issue still exists, gather relevant information and git history to inform a decision, check for similar comments and group them together, and propose 2-3 resolutions.
- **Related Check**: Always check for related issues once a fix is decided, all similar ones should be addressed together.

4. **Evaluate**:

- Obvious optimal: Explain your reasoning to the user and propose a fix
- Probable course: Explain your reasoning, ask user to confirm solution
- Otherwise: Present options to the user, they will choose an option or describe something else. The user may ask you to reply rather than fix

5. **Fix or Reply**

- (a) **Fix**
  - **Simple Fix (<5 files, no design changes)** Use your Task tool to execute (avoid context bloat). Continue to step 6.
  - **Complex Fix** If fix requires editing more than 5 files, _produce a planning prompt_ instead, and display the prompt to the User and go back to step 1 unless otherwise instructed.
- (b) **Reply** only when instructed by the user.
  - use `bun discuss.ts reply` to send a message to the bot
  - Golden rule applies, be kind!
  - DO NOT REPLY UNLESS INSTRUCTED BY THE USER

6. **Test** This is critical! You MUST test! `bun bd test ./packages/bun-otel/*.test.ts ./packages/bun-otel/test/*.test.ts`
7. **Commit** Write a commit message ONLY for files YOU changed. **Do not `-A`**.
8. **Resolve** - After fixing, testing, and committing: `bun discuss.ts resolve <id> <commit>`
9. **Do not `git push` yet** - Push at the end, only push once **all** comments are resolved

## Comment States

- **Pending** - Needs attention now
- **Snoozed** 😴 - Waiting for bot response (auto after reply)
- **Outdated** ⚠️ - Verify that it's OBE and resolve without comment.
- **Resolved** ✅ - Done and marked on GitHub

## Best Practices

### Handling Comments

- **Be precise** - Cite code/specs when correcting the bot
- **Reply, don't ignore** - Explain your reasoning to the bot
- **Check for duplicates** - Use SQLite queries to find related issues
- **Verify Outdated** - If marked `⚠️ OUTDATED`, code already changed, but check the comment anyway.
- **Reference discussions** - Link to previous conversations for duplicates
- **Commit messages reference comments** - including IDs so the bot can find them

### Resolution

- **Test before resolving** - Verify fix works first
- **Use commit hashes** - Include actual commit in resolve command: `discuss.ts resolve <commentid> <commit-hash>`
- **Batch resolve** - You can include several IDs to resolve at once, best practice is to resolve all related to one file at a time `bun discuss.ts resolve <id1> <id2> <id3> <id4> <commit-hash>`
- **Let bot respond** - Where a comment was sent, check if bot acknowledged before resolving
- **Batch commits** - Avoid rate limits by `push`ing multiple `commit`s together. You can resolve without `push`

### @coderabbitai Bot Interaction

- **Be Kind** - Golden rule... Who knows, it might be AGI.
- **"Hopping back into my burrow"** - Confused by your reply, if the message was intended for the bot, reply again with `@coderrabitai`
- **Pedantic responses** - When the User confirms a choice is intentional, explain "this is a design decision"

## Quick Queries

```bash
# Find duplicates by keyword
sqlite3 discuss.sqlite "SELECT id, path, body FROM comments WHERE body LIKE '%keyword%' AND github_resolved = 0"

# View all critical issues
bun discuss.ts pending --severity critical
```

## Getting Started

```bash
bun discuss.ts help # full command list

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
bun discuss.ts resolve <id> [<id2>, ...<idn>] <commit-hash>

# Track progress
bun discuss.ts stats
bun discuss.ts show <id-from-list> [<id2>, ...<idn>]

# Search
bun discuss.ts search
```

### tips/tricks/learnings to add to the prompt for the next loop

1. Verify bot claims against official sources - The bot claimed detectResources() was async in SDK 2.2.0, but you correctly pointed out the migration guide shows it was made sync.
   Always check migration guides/docs when the bot suggests API changes.
2. Use DB queries to identify comment patterns - The sqlite3 discuss.sqlite "SELECT..." approach helped us find all 15 InstrumentKind comments and realize most were false positives
   or intentional design decisions. This saved a ton of API review fees.
3. Batch replies for design decisions - When multiple comments are about the same intentional choice (like InstrumentKind enum usage in runtime tests), reply once with a list of all
   affected comment IDs rather than replying to each individually.
4. Check for false positives in searches - Comments that mention a term (like InstrumentKind) aren't always about that term. Some were about error handling, private fields, etc.
5. Let the Task agent investigate compilation issues - It's better at exploring the codebase to understand context (like the InstrumentRef class history) than trying to grep around
   manually.
6. Test before committing, even for type changes - The | number removal broke TypeScript compilation in unexpected ways. Always run bun bd and relevant tests. `bun bd test ./packages/bun-otel/test/*.test.ts ./test/js/bun/telemetry/*.test.ts` is the correct command.
7. The workflow is working - fetch → pending (if needed) → show → fix → test → commit with IDs → resolve is efficient.
8. **Outdated comment cleanup patterns** (from 2025-10-28 session):
   - Many outdated comments are for deleted files - check if file exists first with `ls` or `git log -- <file>`
   - Batch resolve by grouping: Get all comment IDs for a deleted file, resolve all with same commit
   - Use `git log --all --oneline -- <file> | head -1` to find the deletion/refactor commit
   - Common pattern: Large refactors delete many files at once (e.g., commit e749aa5948 deleted 3 instrumentation files)
   - Resolved 19/47 outdated comments in first pass, mostly deleted files
   - Actual pending outdated count is lower than stats show - stats includes already-resolved outdated
   - File deletions are the easiest wins - verify with `ls`, find commit, batch resolve all comments for that file

## Summery

Before we start, clear any stale PIDs and outstanding tasks - this is a fresh context.

Remember to work through issues systematically! Don't rush!

Begin with `bun discuss.ts fetch` and end with `bun bd test ./packages/bun-otel/test/*.test.ts ./test/js/bun/telemetry/*.test.ts` - let's go 🚀

## Context

$ARGUMENTS

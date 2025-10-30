---
description: discuss.ts Comment Deduplication & Grouping - Github PR
---

We are analyzing duplicate and related comments in PR https://github.com/oven-sh/bun/pull/NNNN (oven-sh/bun repository). Many review comments are about the same
underlying issue and can be resolved together.

Your goal: Find patterns, group related comments, and identify the top issues to tackle efficiently.

Tool Overview

discuss.ts manages PR review comments with SQLite backend:

- Comments often duplicate across files (same pattern, different location)
- Fixing one issue may resolve 5-10 related comments
- Grouping saves time and reduces redundant work

**⚠️ IMPORTANT: Clean up zombie comments first!**

Before starting deduplication analysis, run the zombies command to mark comments that were deleted from GitHub when files changed:

```bash
# Preview zombies (recommended first)
bun discuss.ts zombies --dry-run

# Mark zombies (removes ~40-70% of false pending comments!)
bun discuss.ts zombies

# Check updated stats
bun discuss.ts stats
```

This dramatically reduces noise by identifying comments already removed from GitHub when code changed. What looks like 120 pending comments might actually be just 51!

Workflow for Grouping Comments

1. Export all pending comments
   bun discuss.ts fetch

# Export to JSON for analysis

sqlite3 discuss.sqlite -json "SELECT id, path, line, body, priority FROM comments WHERE github_resolved = 0 AND outdated = 0 ORDER BY path"

# Or get a quick summary

sqlite3 discuss.sqlite "SELECT id, path, substr(body, 1, 80) as snippet FROM comments WHERE github_resolved = 0 AND outdated = 0" 2. Use Task agent to analyze patterns:
Launch a Task agent with subagent_type="general-purpose" to:

1. Read all pending comments from the database
2. Group comments by:
   - Similar text/keywords (e.g., all mention "type annotation")
   - Same file or module
   - Same underlying issue (e.g., all about InstrumentKind usage)
   - Same code pattern (e.g., all about async/await)
3. Identify:
   - Top 5 most common issues (with count)
   - Files with most comments
   - Comments that can be resolved together
4. Output:
   - Summary table of issue categories
   - Top 3 issue groups with all comment IDs
   - Recommended order to tackle them
5. Analyze Task output:
   - Review the grouped issues
   - Verify groupings make sense (read a few comments from each group)
   - Identify "fix once, resolve many" opportunities
6. Plan resolution strategy:
   - Type A - Same fix everywhere: Fix pattern once, resolve all comments
   - Type B - Design decision: Reply once explaining decision, reference in others
   - Type C - File-specific: Group by file, fix file by file
   - Type D - False positives: Identify incorrect bot suggestions to batch-reject
7. Report to user:
   Present findings:
   - "Found 15 comments about InstrumentKind - all can be resolved with one design decision explanation"
   - "8 comments about missing error handling - need fixes in 3 files"
   - "12 comments about type annotations - 6 already fixed (outdated), 6 need attention"

Key Commands

# Fetch latest

bun discuss.ts fetch

# Count by keyword

sqlite3 discuss.sqlite "SELECT COUNT(\*) FROM comments WHERE body LIKE '%InstrumentKind%' AND github_resolved = 0"

# Find similar comments

sqlite3 discuss.sqlite "SELECT id, path, body FROM comments WHERE body LIKE '%keyword%' AND github_resolved = 0"

# Group by file

sqlite3 discuss.sqlite "SELECT path, COUNT(\*) as cnt FROM comments WHERE github_resolved = 0 AND outdated = 0 GROUP BY path ORDER BY cnt DESC"

# Group by priority

sqlite3 discuss.sqlite "SELECT priority, COUNT(\*) as cnt FROM comments WHERE github_resolved = 0 GROUP BY priority"

# View specific group

bun discuss.ts show <id1>
bun discuss.ts show <id2>

# ... compare manually

Common Duplication Patterns

Pattern categories to look for:

1. Type/Interface Issues
   - "Add type annotation"
   - "Use interface instead of type"
   - "Add readonly modifier"
   - → Group: TypeScript type improvements
2. Error Handling
   - "Add try/catch"
   - "Handle error case"
   - "Add null check"
   - → Group: Missing error handling
3. Design Decisions
   - "Consider using enum"
   - "Extract to constant"
   - "Use dependency injection"
   - → Group: Architectural suggestions (may reject)
4. Documentation
   - "Add JSDoc comment"
   - "Document parameter"
   - "Add example"
   - → Group: Documentation improvements
5. Code Style
   - "Use const instead of let"
   - "Prefer arrow function"
   - "Remove unused variable"
   - → Group: Style/linting issues
6. Test Coverage
   - "Add test for error case"
   - "Add integration test"
   - "Mock this dependency"
   - → Group: Testing gaps

Analysis Task Prompt Template

Analyze all pending PR review comments to identify duplicates and patterns.

Database location: discuss.sqlite

Query to get all pending comments:

````sql
SELECT id, path, line, body, priority, severity
FROM comments
WHERE github_resolved = 0 AND outdated = 0
ORDER BY path, line

Tasks:
1. Read all pending comments from the database
2. Categorize comments by:
   - Similar keywords/phrases (extract top 10 keywords)
   - Common underlying issues
   - Files with most comments
   - Priority distribution
3. Create groups where comments can be resolved together
4. Identify:
   - Top 5 most duplicated issues (with counts and comment IDs)
   - Top 3 files with most comments
   - Comments about intentional design decisions
   - Comments that may be false positives

Output format:
## Summary
- Total pending: X
- Unique issues: ~Y
- Top file: Z (N comments)

## Top 5 Issue Groups
1. **Issue Name** (count: N)
   - Description: ...
   - Comment IDs: [id1, id2, id3, ...]
   - Suggested action: ...

2. **Issue Name** (count: N)
   ...

## Recommended Tackle Order
1. Group X - Fix once, resolve N comments
2. Group Y - Reply to design decision, reference in N comments
3. ...

## Files Needing Most Attention
1. file/path (N comments)
2. file/path (M comments)
...

Be thorough but concise. Focus on actionable groupings.

## Example Analysis Output

```markdown
## Summary
- Total pending: 179
- Unique issues: ~45
- Top file: BunSDK.ts (12 comments)

## Top 5 Issue Groups

1. **InstrumentKind enum usage in runtime tests** (count: 15)
   - Description: Bot wants string literals, but enum access is intentional for type safety
   - Comment IDs: [2462716617, 2462727861, 2463815727, 2462716623, 2462702493, ...]
   - Suggested action: Reply once explaining design decision, batch resolve others

2. **Missing type annotations on function returns** (count: 11)
   - Description: Functions lack explicit return types
   - Comment IDs: [2461234567, 2461234589, ...]
   - Files: BunSDK.ts (4), capabilities.ts (3), OtelCapabilitiesImpl.ts (4)
   - Suggested action: Add return types, resolve per-file

3. **Error handling in async functions** (count: 8)
   - Description: Missing try/catch or error propagation
   - Comment IDs: [2461234600, 2461234611, ...]
   - Files: BunHttpInstrumentation.ts (5), BunFetchInstrumentation.ts (3)
   - Suggested action: Add error handling, resolve together

4. **JSDoc documentation missing** (count: 7)
   - Description: Public APIs lack documentation
   - Comment IDs: [...]
   - Suggested action: Add docs, batch commit

5. **Unused imports** (count: 6)
   - Description: Imports not used in file
   - Comment IDs: [...]
   - Suggested action: Quick fix, resolve together

## Recommended Tackle Order
1. **InstrumentKind group** - One reply resolves 15 comments (high leverage)
2. **Error handling** - Real issues, need fixes in 2 files (high priority)
3. **Type annotations** - Straightforward fixes across 3 files
4. **Documentation** - Lower priority, batch later
5. **Unused imports** - Trivial, clean up at end

Task Execution

1. Launch analysis task:
# Use Task tool with subagent_type="general-purpose"
# Provide the analysis prompt above
# Wait for comprehensive grouping report
2. Review task output:
   - Check if groupings make sense
   - Verify comment IDs are accurate
   - Read a sample comment from each group to confirm
3. Present to user:
   - Show top 3-5 issue groups with IDs
   - Recommend resolution strategy for each
   - Get user approval before tackling
4. Execute plan:
   - Work through groups in recommended order
   - Reference other comment IDs when resolving related issues
   - Batch commits where possible

Success Metrics

- Identify: 80%+ of comments fall into clear groups
- Leverage: Find at least 3 "fix once, resolve many" opportunities
- Clarity: User can see exactly which issues to tackle first
- Efficiency: Save 50%+ time vs. handling comments individually

Tips

1. Keywords are clues - "type", "error", "async", "import" indicate common issues
2. File clustering - Many comments in one file = systemic issue
3. Priority matters - Group critical issues separately from trivial
4. Design vs. bugs - Separate intentional choices from real issues
5. Sample first - Read 2-3 comments from each group to verify accuracy
6. Update as you go - Re-run analysis after resolving large groups

Getting Started

# Step 1: Fetch latest state
bun discuss.ts fetch

# Step 2: Clean up zombie comments (IMPORTANT!)
bun discuss.ts zombies --dry-run  # Preview first
bun discuss.ts zombies            # Mark zombies

# Step 3: Check realistic stats
bun discuss.ts stats

# Step 4: Export for analysis
sqlite3 discuss.sqlite -json "SELECT * FROM comments WHERE github_resolved = 0 AND outdated = 0" > pending_comments.json

# Step 5: Launch Task agent with analysis prompt
# (Use Task tool with subagent_type="general-purpose")

Let's find the patterns and work smarter, not harder! 🧠🔍
````

## Context

$ARGUMENTS

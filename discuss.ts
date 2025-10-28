#!/usr/bin/env bun
/**
 * discuss.ts - PR Review Comment Manager (Refactored)
 *
 * A CLI tool to fetch, organize, and track resolution of GitHub PR review comments.
 * Uses Bun's native SQLite and shell capabilities.
 *
 * Usage:
 *   bun discuss.ts fetch [pr-number]    - Fetch comments from GitHub
 *   bun discuss.ts list [--priority X]  - List comments (filtered by priority)
 *   bun discuss.ts show <id>            - Show full comment details
 *   bun discuss.ts note <id> <text>     - Add a note to a comment
 *   bun discuss.ts resolve <id> [commit] - Mark comment as resolved
 *   bun discuss.ts unresolve <id>       - Mark comment as unresolved
 *   bun discuss.ts pending              - Show only unresolved comments
 *   bun discuss.ts stats                - Show summary statistics
 */

import { $ } from "bun";
import { Database } from "bun:sqlite";

// ============================================================================
// CONSTANTS & CONFIGURATION
// ============================================================================

const DB_PATH = "./discuss.sqlite";
const DEFAULT_PR = "24063";
const REPO = "oven-sh/bun";
const SCRIPT_NAME = "discuss.ts";

const SEVERITY_ORDER: Record<string, number> = {
  critical: 1,
  major: 2,
  minor: 3,
  trivial: 4,
};

const SEVERITY_EMOJI: Record<string, string> = {
  critical: "🔴",
  major: "🟠",
  minor: "🟡",
  trivial: "🔵",
  unknown: "⚪",
};

const PRIORITY_EMOJI: Record<string, string> = {
  issue: "⚠️",
  refactor: "🛠️",
  nitpick: "🧹",
  unknown: "❓",
};

const PRIORITY_MARKERS: Record<string, string> = {
  "⚠️ Potential issue": "issue",
  "🛠️ Refactor suggestion": "refactor",
  "🧹 Nitpick": "nitpick",
};

const SEVERITY_MARKERS: Record<string, string> = {
  "🔴 Critical": "critical",
  "🟠 Major": "major",
  "🟡 Minor": "minor",
  "🔵 Trivial": "trivial",
};

// ============================================================================
// TYPES & INTERFACES
// ============================================================================

interface Comment {
  id: number;
  path: string;
  line: number | null;
  body: string;
  priority: string;
  severity: string;
  outdated: boolean;
  created_at: string;
  updated_at: string;
  user: string;
  first_seen: string;
  thread_id: string | null;
  github_resolved: boolean;
  resolved_commit: string | null;
  waiting_reply: boolean;
  notes: string | null;
}

interface Reply {
  id: number;
  in_reply_to_id: number;
  body: string;
  user: string;
  created_at: string;
  updated_at: string;
}

interface ThreadInfo {
  threadId: string;
  isResolved: boolean;
  isOutdated: boolean;
}

interface DisplayOptions {
  showStatus?: boolean;
  showOutdated?: boolean;
  showSnoozed?: boolean;
}

// ============================================================================
// DATABASE SETUP
// ============================================================================

const db = (() => {
  const database = new Database(DB_PATH);
  database.exec(`
    CREATE TABLE IF NOT EXISTS comments (
      id INTEGER PRIMARY KEY,
      path TEXT NOT NULL,
      line INTEGER,
      body TEXT NOT NULL,
      priority TEXT NOT NULL,
      severity TEXT NOT NULL,
      outdated INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      user TEXT NOT NULL,
      first_seen TEXT NOT NULL,
      thread_id TEXT,
      github_resolved INTEGER NOT NULL DEFAULT 0,
      resolved_commit TEXT,
      waiting_reply INTEGER NOT NULL DEFAULT 0,
      snoozed_reply_count INTEGER DEFAULT 0,
      notes TEXT
    );

    CREATE TABLE IF NOT EXISTS replies (
      id INTEGER PRIMARY KEY,
      in_reply_to_id INTEGER NOT NULL,
      body TEXT NOT NULL,
      user TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (in_reply_to_id) REFERENCES comments(id)
    );

    CREATE INDEX IF NOT EXISTS idx_github_resolved ON comments(github_resolved);
    CREATE INDEX IF NOT EXISTS idx_priority ON comments(priority);
    CREATE INDEX IF NOT EXISTS idx_path ON comments(path);
    CREATE INDEX IF NOT EXISTS idx_replies_parent ON replies(in_reply_to_id);
  `);
  return database;
})();

// ============================================================================
// UTILITIES
// ============================================================================

const deferredLogs: Array<() => void> = [];

function deferLog(x: any): void {
  deferredLogs.push(() => console.log(x));
}

function printAtTheEnd(): Disposable {
  return {
    [Symbol.dispose]() {
      deferredLogs.forEach(fn => fn());
    },
  };
}

function buildSeverityOrderClause(): string {
  return `CASE severity WHEN 'critical' THEN 1 WHEN 'major' THEN 2 WHEN 'minor' THEN 3 WHEN 'trivial' THEN 4 ELSE 5 END`;
}

function extractSuggestion(body: string): string {
  const lines = body.split("\n");
  const suggestion = lines.find(l => l.startsWith("**")) || "";
  return suggestion.replace(/\*\*/g, "").trim();
}

function formatLineInfo(line: number | null): string {
  return line ? `:${line}` : "";
}

function truncate(text: string, maxLength: number): string {
  return text.length > maxLength ? `${text.substring(0, maxLength)}...` : text;
}

// ============================================================================
// DISPLAY UTILITIES
// ============================================================================

function formatCommentHeader(comment: Comment, options: DisplayOptions = {}): string {
  const parts: string[] = [];

  if (options.showStatus) {
    parts.push(comment.github_resolved ? "✅" : "  ");
  }

  if (options.showSnoozed && comment.waiting_reply) {
    parts.push("😴");
  }

  parts.push(`[${comment.id}]`);
  parts.push(PRIORITY_EMOJI[comment.priority] || "");
  parts.push(`${comment.path}${formatLineInfo(comment.line)}`);

  if (options.showOutdated && comment.outdated) {
    parts.push("(outdated)");
  }

  return parts.filter(p => p).join(" ");
}

function printSeveritySection(severity: string, lastSeverity: string): string {
  if (severity !== lastSeverity) {
    return `\n${SEVERITY_EMOJI[severity] || "⚪"} ${severity.toUpperCase()}`;
  }
  return "";
}

function printCommentSummary(comment: Comment, options: DisplayOptions = {}): void {
  const header = printSeveritySection(comment.severity, "");
  if (header) console.log(header);

  console.log(`  ${formatCommentHeader(comment, options)}`);

  const suggestion = extractSuggestion(comment.body);
  if (suggestion) {
    console.log(`      ${truncate(suggestion, 100)}`);
  }
}

// ============================================================================
// PARSING
// ============================================================================

function parseComment(body: string): { priority: string; severity: string } {
  const firstLine = body.split("\n")[0] || "";

  let priority = "unknown";
  let severity = "unknown";

  for (const [marker, val] of Object.entries(PRIORITY_MARKERS)) {
    if (firstLine.includes(marker)) {
      priority = val;
      break;
    }
  }

  for (const [marker, val] of Object.entries(SEVERITY_MARKERS)) {
    if (firstLine.includes(marker)) {
      severity = val;
      break;
    }
  }

  return { priority, severity };
}

// ============================================================================
// GITHUB API - GRAPHQL
// ============================================================================

async function executeGraphQLMutation(
  mutation: string,
  threadId: string,
  operationName: string,
): Promise<boolean | "stale"> {
  if (!threadId) {
    console.warn(`⚠️ No thread ID to ${operationName}`);
    return false;
  }

  try {
    const result = await $`gh api graphql -F threadId="${threadId}" -f query='${mutation}'`.json();

    const threadData = result.data?.resolveReviewThread?.thread || result.data?.unresolveReviewThread?.thread;
    const expectedResolved = operationName === "resolve";

    if (threadData && threadData.isResolved === expectedResolved) {
      console.log(`✅ ${operationName === "resolve" ? "Resolved" : "Unresolved"} thread on GitHub: ${threadId}`);
      return true;
    } else if (result.errors?.some((e: any) => e.type === "NOT_FOUND")) {
      console.warn(`⚠️ Thread ID is stale (comment may have been deleted): ${threadId}`);
      return "stale";
    } else {
      console.warn(`⚠️ Failed to ${operationName} thread: ${threadId}`);
      return false;
    }
  } catch (error: any) {
    if (error.stdout) {
      try {
        const result = JSON.parse(error.stdout);
        if (result.errors?.some((e: any) => e.type === "NOT_FOUND")) {
          console.warn(`⚠️ Thread ID is stale (comment may have been deleted): ${threadId}`);
          return "stale";
        }
      } catch {
        // Fall through to generic error
      }
    }
    console.error(`❌ Error ${operationName}ing thread:`, error);
    return false;
  }
}

async function resolveThreadOnGitHub(threadId: string): Promise<boolean | "stale"> {
  const mutation = `
    mutation ResolveThread($threadId: ID!) {
      resolveReviewThread(input: { threadId: $threadId }) {
        thread {
          id
          isResolved
        }
      }
    }`;
  return executeGraphQLMutation(mutation, threadId, "resolve");
}

async function unresolveThreadOnGitHub(threadId: string): Promise<boolean | "stale"> {
  const mutation = `
    mutation UnresolveThread($threadId: ID!) {
      unresolveReviewThread(input: { threadId: $threadId }) {
        thread {
          id
          isResolved
        }
      }
    }`;
  return executeGraphQLMutation(mutation, threadId, "unresolve");
}

async function fetchThreadMetadata(prNumber: string): Promise<Map<number, ThreadInfo>> {
  const threadInfo = new Map<number, ThreadInfo>();
  let hasNextPage = true;
  let cursor: string | null = null;
  let pageCount = 0;

  while (hasNextPage) {
    pageCount++;
    const cursorArg = cursor ? `, after: "${cursor}"` : "";

    const threadsResult = await $`gh api graphql -f query='
{
  repository(owner: "oven-sh", name: "bun") {
    pullRequest(number: ${prNumber}) {
      reviewThreads(first: 100${cursorArg}) {
        pageInfo {
          hasNextPage
          endCursor
        }
        nodes {
          id
          isResolved
          isOutdated
          comments(first: 100) {
            nodes {
              databaseId
              outdated
            }
          }
        }
      }
    }
  }
}'`.json();

    const threads = threadsResult.data?.repository?.pullRequest?.reviewThreads?.nodes || [];
    const pageInfo = threadsResult.data?.repository?.pullRequest?.reviewThreads?.pageInfo;

    deferLog(`   Page ${pageCount}: Found ${threads.length} threads`);

    for (const thread of threads) {
      for (const comment of thread.comments.nodes) {
        threadInfo.set(comment.databaseId, {
          threadId: thread.id,
          isResolved: thread.isResolved,
          isOutdated: comment.outdated,
        });
      }
    }

    hasNextPage = pageInfo?.hasNextPage || false;
    cursor = pageInfo?.endCursor || null;
  }

  deferLog(`   Total: ${threadInfo.size} comments mapped to threads across ${pageCount} pages`);
  return threadInfo;
}

// ============================================================================
// GITHUB API - REST
// ============================================================================

async function fetchPRComments(prNumber: string): Promise<{ comments: any[]; replies: any[] }> {
  const result = await $`gh api repos/${REPO}/pulls/${prNumber}/comments --paginate`.json();
  const comments = Array.isArray(result) ? result : [];

  const topLevel = comments.filter((c: any) => !c.in_reply_to_id);
  const replies = comments.filter((c: any) => c.in_reply_to_id);

  return { comments: topLevel, replies };
}

async function postCommentReply(id: string, replyBody: string, prNumber: string): Promise<void> {
  await $`gh api repos/${REPO}/pulls/${prNumber}/comments -X POST -f body=${replyBody} -f subject_type=line -F in_reply_to=${parseInt(id)}`.quiet();
}

// ============================================================================
// DATA OPERATIONS
// ============================================================================

function getComment(id: number): Comment | null {
  return db.query("SELECT * FROM comments WHERE id = ?").get(id) as Comment | null;
}

function getReplies(commentId: number): Reply[] {
  return db.query("SELECT * FROM replies WHERE in_reply_to_id = ? ORDER BY created_at").all(commentId) as Reply[];
}

function getReplyCount(commentId: number): number {
  const result = db.query("SELECT COUNT(*) as count FROM replies WHERE in_reply_to_id = ?").get(commentId) as {
    count: number;
  };
  return result.count;
}

function getSnoozedComments(): Array<{ id: number; snoozed_reply_count: number }> {
  return db.query("SELECT id, snoozed_reply_count FROM comments WHERE waiting_reply = 1").all() as Array<{
    id: number;
    snoozed_reply_count: number;
  }>;
}

function upsertComment(comment: any, threadInfo: ThreadInfo | null, now: string): { wasNew: boolean } {
  const { priority, severity } = parseComment(comment.body);
  const existing = db.query("SELECT id FROM comments WHERE id = ?").get(comment.id);

  const info = threadInfo || { threadId: null, isResolved: false, isOutdated: false };

  const insert = db.prepare(`
    INSERT OR REPLACE INTO comments (
      id, path, line, body, priority, severity, outdated,
      created_at, updated_at, user, first_seen,
      thread_id, github_resolved, resolved_commit, waiting_reply, snoozed_reply_count, notes
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
      COALESCE((SELECT first_seen FROM comments WHERE id = ?), ?),
      ?, ?,
      (SELECT resolved_commit FROM comments WHERE id = ?),
      COALESCE((SELECT waiting_reply FROM comments WHERE id = ?), 0),
      COALESCE((SELECT snoozed_reply_count FROM comments WHERE id = ?), 0),
      (SELECT notes FROM comments WHERE id = ?)
    )
  `);

  insert.run(
    comment.id,
    comment.path,
    comment.line,
    comment.body,
    priority,
    severity,
    info.isOutdated ? 1 : 0,
    comment.created_at,
    comment.updated_at,
    comment.user.login,
    comment.id,
    now,
    info.threadId,
    info.isResolved ? 1 : 0,
    comment.id,
    comment.id,
    comment.id,
    comment.id,
  );

  return { wasNew: !existing };
}

function upsertReply(reply: any): void {
  const insert = db.prepare(`
    INSERT OR REPLACE INTO replies (
      id, in_reply_to_id, body, user, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?)
  `);
  insert.run(reply.id, reply.in_reply_to_id, reply.body, reply.user.login, reply.created_at, reply.updated_at);
}

function processAutoUnsnooze(): number {
  const snoozedComments = getSnoozedComments();
  let unsnoozedCount = 0;

  for (const snoozed of snoozedComments) {
    const currentReplyCount = getReplyCount(snoozed.id);

    if (currentReplyCount > snoozed.snoozed_reply_count) {
      db.prepare("UPDATE comments SET waiting_reply = 0, snoozed_reply_count = 0 WHERE id = ?").run(snoozed.id);
      unsnoozedCount++;
    }
  }

  return unsnoozedCount;
}

function updateCommentField(id: number, field: string, value: any): void {
  db.prepare(`UPDATE comments SET ${field} = ? WHERE id = ?`).run(value, id);
}

function clearStaleThreadId(id: number): void {
  updateCommentField(id, "thread_id", null);
}

// ============================================================================
// BUSINESS LOGIC - FETCH
// ============================================================================

async function fetchComments(prNumber: string = DEFAULT_PR): Promise<void> {
  console.log(`📥 Fetching comments for PR #${prNumber}...`);

  try {
    using _1 = printAtTheEnd();

    // Step 1: Fetch comments via REST API
    const { comments, replies } = await fetchPRComments(prNumber);
    deferLog(`   Found ${comments.length} top-level comments, ${replies.length} replies`);

    // Step 2: Fetch thread metadata via GraphQL
    const threadInfo = await fetchThreadMetadata(prNumber);

    // Step 3: Store comments
    const now = new Date().toISOString();
    let newCount = 0;
    let updatedCount = 0;

    for (const comment of comments) {
      const info = threadInfo.get(comment.id) || null;
      const { wasNew } = upsertComment(comment, info, now);
      if (wasNew) newCount++;
      else updatedCount++;
    }

    // Step 4: Store replies
    for (const reply of replies) {
      upsertReply(reply);
    }

    // Step 5: Auto-unsnooze
    const unsnoozedCount = processAutoUnsnooze();

    // Step 6: Print summary
    const resolvedCount = Array.from(threadInfo.values()).filter(t => t.isResolved).length;
    const outdatedCount = Array.from(threadInfo.values()).filter(t => t.isOutdated).length;

    console.log(
      `➡️  Imported ${newCount} new, 🔂 updated ${updatedCount} existing comments, 📥 ${replies.length} replies`,
    );
    if (unsnoozedCount > 0) {
      console.log(`   🔔 Auto-unsnoozed ${unsnoozedCount} comments with new replies`);
    }

    // Step 7: Show current status
    await printFetchSummary(resolvedCount, outdatedCount);
  } catch (error) {
    console.error(`❌ Failed to fetch comments:`, error);
    process.exit(1);
  }
}

async function printFetchSummary(resolvedCount: number, outdatedCount: number): Promise<void> {
  const statusStats = db
    .query(
      `
    SELECT
      severity,
      SUM(CASE WHEN github_resolved = 0 AND waiting_reply = 0 THEN 1 ELSE 0 END) as pending_count
    FROM comments
    GROUP BY severity
    ORDER BY ${buildSeverityOrderClause()}
  `,
    )
    .all() as { severity: string; pending_count: number }[];

  const totalPending = statusStats.reduce((sum, row) => sum + row.pending_count, 0);
  const criticalCount = statusStats.find(r => r.severity === "critical")?.pending_count || 0;
  const majorCount = statusStats.find(r => r.severity === "major")?.pending_count || 0;
  const minorCount = statusStats.find(r => r.severity === "minor")?.pending_count || 0;
  const trivialCount = statusStats.find(r => r.severity === "trivial")?.pending_count || 0;

  console.log(`📊 Current Status:`);
  console.log(
    `   ⏳ ${totalPending} pending (${criticalCount} 🔴 critical, ${majorCount} 🟠 major, ${minorCount} 🟡 minor, ${trivialCount} 🔵 trivial)`,
  );
  console.log(`   ✅ ${resolvedCount} threads resolved ⚠️  ${outdatedCount} comments outdated`);

  if (criticalCount > 0) {
    await printCriticalPreview(criticalCount);
  }
}

async function printCriticalPreview(criticalCount: number): Promise<void> {
  const criticalItems = db
    .query(
      `
    SELECT id, path, line, body
    FROM comments
    WHERE severity = 'critical' AND github_resolved = 0 AND waiting_reply = 0
    ORDER BY path
    LIMIT 5
  `,
    )
    .all() as { id: number; path: string; line: number | null; body: string }[];

  console.log(`\n🔴 Next: ${criticalCount} Critical Item${criticalCount === 1 ? "" : "s"}`);

  for (const item of criticalItems) {
    console.log(`   [${item.id}] ${item.path}${formatLineInfo(item.line)}`);
    const suggestion = extractSuggestion(item.body);
    if (suggestion) {
      console.log(`       → ${truncate(suggestion, 80)}`);
    }
  }

  if (criticalCount > 5) {
    console.log(`   ... (${criticalCount - 5} more critical items)`);
  }

  console.log(`\n💡 Run 'bun ${SCRIPT_NAME} pending --priority critical' to see all`);
}

// ============================================================================
// BUSINESS LOGIC - DISPLAY COMMANDS
// ============================================================================

function listComments(priorityFilter?: string): void {
  let query = "SELECT * FROM comments";
  const params: any[] = [];

  if (priorityFilter) {
    query += " WHERE severity = ?";
    params.push(priorityFilter);
  }

  query += ` ORDER BY ${buildSeverityOrderClause()}, github_resolved ASC, path`;

  const comments = db.query(query).all(...params) as Comment[];

  if (comments.length === 0) {
    console.log("No comments found.");
    return;
  }

  let lastSeverity = "";

  for (const comment of comments) {
    const header = printSeveritySection(comment.severity, lastSeverity);
    if (header) console.log(header);
    lastSeverity = comment.severity;

    const status = comment.github_resolved ? "✅" : "  ";
    const outdated = comment.outdated ? "(outdated)" : "";
    const lineInfo = formatLineInfo(comment.line);

    console.log(
      `  ${status} [${comment.id}] ${PRIORITY_EMOJI[comment.priority] || ""} ${comment.path}${lineInfo} ${outdated}`,
    );

    const suggestion = extractSuggestion(comment.body);
    if (suggestion) {
      console.log(`      ${truncate(suggestion, 80)}`);
    }
  }

  console.log();
}

function searchComments(query: string, showResolved: boolean = false): void {
  const resolvedFilter = showResolved ? "" : "AND github_resolved = 0";

  const comments = db
    .query(
      `
    SELECT * FROM comments
    WHERE (body LIKE ? OR path LIKE ?)
    ${resolvedFilter}
    ORDER BY ${buildSeverityOrderClause()}, github_resolved ASC, path
  `,
    )
    .all(`%${query}%`, `%${query}%`) as Comment[];

  if (comments.length === 0) {
    console.log(`🔍 No comments found matching: "${query}"`);
    return;
  }

  console.log(`\n🔍 Found ${comments.length} comment(s) matching: "${query}"`);
  console.log();

  let lastSeverity = "";

  for (const comment of comments) {
    const header = printSeveritySection(comment.severity, lastSeverity);
    if (header) console.log(header);
    lastSeverity = comment.severity;

    console.log(`  ${formatCommentHeader(comment, { showStatus: true, showOutdated: true, showSnoozed: true })}`);

    const suggestion = extractSuggestion(comment.body);
    if (suggestion) {
      console.log(`      ${truncate(suggestion, 80)}`);
    }
  }

  console.log();
}

function showComment(id: string): void {
  const comment = getComment(parseInt(id));

  if (!comment) {
    console.error(`❌ Comment #${id} not found`);
    process.exit(1);
  }

  const replies = getReplies(parseInt(id));

  console.log(`\n📝 Comment #${comment.id}`);
  console.log(`   File: ${comment.path}${formatLineInfo(comment.line)}`);
  console.log(`   Priority: ${comment.priority} | Severity: ${comment.severity}`);

  const status = comment.github_resolved ? "✅ Resolved" : "⏳ Pending";
  console.log(`   Status: ${status}${comment.waiting_reply ? " (snoozed)" : ""}`);

  if (comment.github_resolved && comment.resolved_commit) {
    console.log(`   Resolved in: ${comment.resolved_commit}`);
  }

  if (comment.thread_id) {
    console.log(`   Thread ID: ${comment.thread_id}`);
  }

  console.log(`   Created: ${comment.created_at}`);
  console.log(`   Updated: ${comment.updated_at}`);
  console.log(`   First seen: ${comment.first_seen}`);
  console.log(`   Author: ${comment.user}`);

  if (comment.outdated) {
    console.log(`   ⚠️  OUTDATED`);
  }

  console.log(`\n   Body:`);
  console.log(
    `   ${comment.body
      .split("\n")
      .map(l => "   " + l)
      .join("\n")}`,
  );

  if (replies.length > 0) {
    console.log(`\n   💬 ${replies.length} ${replies.length === 1 ? "Reply" : "Replies"}:`);
    for (const reply of replies) {
      console.log(`\n   ┌─ ${reply.user} @ ${new Date(reply.created_at).toLocaleString()}`);
      const lines = reply.body.split("\n");
      for (const line of lines.slice(0, 10)) {
        console.log(`   │  ${line}`);
      }
      if (lines.length > 10) {
        console.log(`   │  ... (${lines.length - 10} more lines)`);
      }
      console.log(`   └─`);
    }
  }

  if (comment.notes) {
    console.log(`\n   📌 Notes:`);
    console.log(`   ${comment.notes.split("\n").join("\n   ")}`);
  }

  console.log();
}

function showPending(severityFilter?: string, showSnoozed: boolean = false): void {
  const severityClause = severityFilter ? `AND severity = '${severityFilter}'` : "";

  const activeComments = db
    .query(
      `
    SELECT * FROM comments
    WHERE github_resolved = 0 ${severityClause} AND waiting_reply = 0
    ORDER BY ${buildSeverityOrderClause()}, path
  `,
    )
    .all() as Comment[];

  const snoozedComments = showSnoozed
    ? (db
        .query(
          `
    SELECT * FROM comments
    WHERE github_resolved = 0 ${severityClause} AND waiting_reply = 1
    ORDER BY ${buildSeverityOrderClause()}, path
  `,
        )
        .all() as Comment[])
    : [];

  if (activeComments.length === 0 && snoozedComments.length === 0) {
    const filterMsg = severityFilter ? ` (severity: ${severityFilter})` : "";
    console.log(`🎉 No pending comments${filterMsg}!`);
    return;
  }

  let header = "Pending Comments";
  if (severityFilter) header += ` (severity: ${severityFilter})`;

  if (activeComments.length > 0) {
    console.log(`\n⏳ ${activeComments.length} ${header}\n`);
    printCommentList(activeComments);
  }

  if (showSnoozed && snoozedComments.length > 0) {
    let snoozedHeader = "Snoozed (Waiting for Reply";
    if (severityFilter) snoozedHeader += `, severity: ${severityFilter}`;
    snoozedHeader += ")";
    console.log(`\n\n😴 ${snoozedComments.length} ${snoozedHeader}\n`);
    printCommentList(snoozedComments);
  }

  console.log();
}

function printCommentList(comments: Comment[]): void {
  let lastSeverity = "";

  for (const comment of comments) {
    const header = printSeveritySection(comment.severity, lastSeverity);
    if (header) console.log(header);
    lastSeverity = comment.severity;

    console.log(`  [${comment.id}] ${comment.path}${formatLineInfo(comment.line)}`);

    const suggestion = extractSuggestion(comment.body);
    if (suggestion) {
      console.log(`      → ${truncate(suggestion, 100)}`);
    }
  }
}

function showStats(): void {
  const total = db.query("SELECT COUNT(*) as count FROM comments").get() as { count: number };
  const resolved = db.query("SELECT COUNT(*) as count FROM comments WHERE github_resolved = 1").get() as {
    count: number;
  };
  const pending = db.query("SELECT COUNT(*) as count FROM comments WHERE github_resolved = 0").get() as {
    count: number;
  };
  const outdated = db.query("SELECT COUNT(*) as count FROM comments WHERE outdated = 1").get() as { count: number };
  const snoozed = db
    .query("SELECT COUNT(*) as count FROM comments WHERE waiting_reply = 1 AND github_resolved = 0")
    .get() as { count: number };

  const bySeverityAll = db
    .query(
      `
    SELECT
      severity,
      SUM(CASE WHEN github_resolved = 0 THEN 1 ELSE 0 END) as pending_count,
      SUM(CASE WHEN github_resolved = 1 THEN 1 ELSE 0 END) as resolved_count,
      SUM(CASE WHEN outdated = 1 THEN 1 ELSE 0 END) as outdated_count
    FROM comments
    GROUP BY severity
    ORDER BY ${buildSeverityOrderClause()}
  `,
    )
    .all() as { severity: string; pending_count: number; resolved_count: number; outdated_count: number }[];

  console.log(`\n# Total Comments: ${total.count}`);

  console.log(`⏳ Pending comments: ${pending.count}`);
  for (const row of bySeverityAll) {
    if (row.pending_count > 0) {
      const emoji = SEVERITY_EMOJI[row.severity] || "⚪";
      console.log(`   ${emoji} ${row.severity.padEnd(10)}: ${row.pending_count} pending`);
    }
  }

  console.log();
  console.log(`😴 Snoozed (waiting reply): ${snoozed.count}`);
  console.log();

  const doneCount = resolved.count + outdated.count;
  console.log(`✅ Done: ${doneCount} (Resolved: ${resolved.count}, Outdated: ${outdated.count})`);
  for (const row of bySeverityAll) {
    if (row.resolved_count > 0 || row.outdated_count > 0) {
      const emoji = SEVERITY_EMOJI[row.severity] || "⚪";
      console.log(
        `   ${emoji} ${row.severity.padEnd(10)}: ${row.resolved_count} resolved, ${row.outdated_count} outdated`,
      );
    }
  }

  console.log();
}

// ============================================================================
// BUSINESS LOGIC - STATE MANAGEMENT
// ============================================================================

function addNote(id: string, noteText: string): void {
  const existing = db.query("SELECT notes FROM comments WHERE id = ?").get(parseInt(id)) as {
    notes: string | null;
  } | null;

  if (!existing) {
    console.error(`❌ Comment #${id} not found`);
    process.exit(1);
  }

  const timestamp = new Date().toISOString();
  const newNote = `[${timestamp}] ${noteText}`;
  const updatedNotes = existing.notes ? `${existing.notes}\n${newNote}` : newNote;

  updateCommentField(parseInt(id), "notes", updatedNotes);
  console.log(`✅ Added note to comment #${id}`);
}

async function resolveComment(id: string, commit?: string, replyMessage?: string): Promise<void> {
  const comment = db.query("SELECT thread_id, path FROM comments WHERE id = ?").get(parseInt(id)) as {
    thread_id: string | null;
    path: string;
  } | null;

  if (!comment) {
    console.error(`❌ Comment #${id} not found`);
    process.exit(1);
  }

  if (!comment.thread_id) {
    console.warn(`⚠️ No thread ID for comment #${id} - cannot resolve on GitHub`);
    console.warn(`   Try running: bun ${SCRIPT_NAME} fetch`);
    process.exit(1);
  }

  if (replyMessage) {
    console.log(`💬 Posting reply to comment #${id}...`);
    try {
      await replyToComment(id, replyMessage);
      console.log(`✅ Reply posted`);
    } catch (error) {
      console.error(`❌ Failed to post reply:`, error);
    }
  }

  console.log(`🔄 Resolving thread on GitHub...`);
  const resolved = await resolveThreadOnGitHub(comment.thread_id);

  if (resolved === "stale") {
    clearStaleThreadId(parseInt(id));
    console.warn(`⚠️ Thread ID was stale (comment may have been deleted from GitHub)`);
    console.warn(`   The comment remains in your local database but can't be resolved on GitHub.`);
    console.warn(`   Consider manually marking this as complete if the issue is resolved.`);
    process.exit(1);
  }

  if (!resolved) {
    console.error(`❌ Failed to resolve thread on GitHub`);
    process.exit(1);
  }

  const resolvedCommit = commit || "HEAD";
  updateCommentField(parseInt(id), "resolved_commit", resolvedCommit);

  console.log(`🔄 Re-syncing with GitHub...`);
  await fetchComments();

  console.log(`✅ Comment #${id} resolved (commit: ${resolvedCommit})`);
}

async function unresolveComment(id: string): Promise<void> {
  const comment = db.query("SELECT thread_id FROM comments WHERE id = ?").get(parseInt(id)) as {
    thread_id: string | null;
  } | null;

  if (!comment) {
    console.error(`❌ Comment #${id} not found`);
    process.exit(1);
  }

  if (!comment.thread_id) {
    console.warn(`⚠️ No thread ID for comment #${id} - cannot unresolve on GitHub`);
    console.warn(`   Try running: bun ${SCRIPT_NAME} fetch`);
    process.exit(1);
  }

  console.log(`🔄 Unresolving thread on GitHub...`);
  const unresolved = await unresolveThreadOnGitHub(comment.thread_id);

  if (unresolved === "stale") {
    clearStaleThreadId(parseInt(id));
    console.warn(`⚠️ Thread ID was stale (comment may have been deleted from GitHub)`);
    console.warn(`   The comment remains in your local database but can't be unresolved on GitHub.`);
    process.exit(1);
  }

  if (!unresolved) {
    console.error(`❌ Failed to unresolve thread on GitHub`);
    process.exit(1);
  }

  updateCommentField(parseInt(id), "resolved_commit", null);

  console.log(`🔄 Re-syncing with GitHub...`);
  await fetchComments();

  console.log(`✅ Comment #${id} marked as unresolved`);
}

async function replyToComment(id: string, replyBody: string): Promise<void> {
  console.log(`💬 Replying to comment #${id}...`);

  try {
    const comment = getComment(parseInt(id));

    if (!comment) {
      console.error(`❌ Comment #${id} not found in database`);
      process.exit(1);
    }

    const allComments = await $`gh api repos/${REPO}/pulls/${DEFAULT_PR}/comments --paginate`.json();
    const ghComment = Array.isArray(allComments) ? allComments.find((c: any) => c.id === parseInt(id)) : null;

    if (!ghComment) {
      console.error(`❌ Comment #${id} not found on GitHub`);
      process.exit(1);
    }

    await postCommentReply(id, replyBody, DEFAULT_PR);

    console.log(`✅ Reply posted to comment #${id}`);
    console.log(`🔄 Refreshing comments...`);

    await fetchComments(DEFAULT_PR);

    const currentReplyCount = getReplyCount(parseInt(id));
    db.prepare("UPDATE comments SET waiting_reply = 1, snoozed_reply_count = ? WHERE id = ?").run(
      currentReplyCount,
      parseInt(id),
    );

    console.log(`😴 Snoozed - waiting for reply`);
  } catch (error) {
    console.error(`❌ Failed to reply:`, error);
    process.exit(1);
  }
}

function snoozeComment(id: string): void {
  const currentReplyCount = getReplyCount(parseInt(id));

  const result = db
    .prepare("UPDATE comments SET waiting_reply = 1, snoozed_reply_count = ? WHERE id = ?")
    .run(currentReplyCount, parseInt(id));

  if (result.changes === 0) {
    console.error(`❌ Comment #${id} not found`);
    process.exit(1);
  }

  console.log(`😴 Snoozed comment #${id} (waiting for reply)`);
}

function unsnoozeComment(id: string): void {
  const result = db
    .prepare("UPDATE comments SET waiting_reply = 0, snoozed_reply_count = 0 WHERE id = ?")
    .run(parseInt(id));

  if (result.changes === 0) {
    console.error(`❌ Comment #${id} not found`);
    process.exit(1);
  }

  console.log(`✅ Unsnoozed comment #${id}`);
}

function unsnoozeAll(): void {
  const result = db
    .prepare("UPDATE comments SET waiting_reply = 0, snoozed_reply_count = 0 WHERE waiting_reply = 1")
    .run();

  console.log(`✅ Unsnoozed ${result.changes} comments`);
}

// ============================================================================
// OUTDATED COMMENT MANAGEMENT
// ============================================================================

async function isFileDeleted(path: string): Promise<boolean> {
  try {
    const file = Bun.file(path);
    return !(await file.exists());
  } catch {
    return true;
  }
}

async function showOutdatedComments(flags: {
  byFile?: boolean;
  count?: boolean;
  deletedFiles?: boolean;
}): Promise<void> {
  const comments = db
    .query("SELECT * FROM comments WHERE outdated = 1 AND github_resolved = 0 ORDER BY path, line")
    .all() as Comment[];

  if (comments.length === 0) {
    console.log("✅ No outdated pending comments found!");
    return;
  }

  // --count flag
  if (flags.count) {
    console.log(`⚠️  ${comments.length} outdated pending comments`);
    return;
  }

  // --deleted-files flag
  if (flags.deletedFiles) {
    console.log("🔍 Checking which files are deleted...\n");
    const deletedComments: Comment[] = [];

    for (const comment of comments) {
      if (await isFileDeleted(comment.path)) {
        deletedComments.push(comment);
      }
    }

    if (deletedComments.length === 0) {
      console.log("✅ No outdated comments for deleted files");
      return;
    }

    console.log(`⚠️  ${deletedComments.length} outdated comments for deleted files:\n`);

    for (const comment of deletedComments) {
      console.log(`  [${comment.id}] ${comment.path}${formatLineInfo(comment.line)}`);
      const snippet = extractSuggestion(comment.body) || truncate(comment.body, 80);
      console.log(`      ${snippet}`);
    }
    console.log();
    return;
  }

  // --by-file flag
  if (flags.byFile) {
    const byFile = new Map<string, Comment[]>();
    for (const comment of comments) {
      if (!byFile.has(comment.path)) {
        byFile.set(comment.path, []);
      }
      byFile.get(comment.path)!.push(comment);
    }

    console.log(`⚠️  ${comments.length} outdated pending comments grouped by file:\n`);

    const sortedFiles = Array.from(byFile.entries()).sort((a, b) => b[1].length - a[1].length);

    for (const [path, fileComments] of sortedFiles) {
      console.log(`  ${path} (${fileComments.length})`);
      for (const comment of fileComments) {
        console.log(`    [${comment.id}]${formatLineInfo(comment.line)}`);
      }
    }
    console.log();
    return;
  }

  // Default: list all
  console.log(`⚠️  ${comments.length} outdated pending comments:\n`);

  for (const comment of comments) {
    console.log(`  [${comment.id}] ${comment.path}${formatLineInfo(comment.line)}`);
    const snippet = extractSuggestion(comment.body) || truncate(comment.body, 80);
    console.log(`      ${snippet}`);
  }
  console.log();
}

async function resolveByFile(path: string, commit: string): Promise<void> {
  const comments = db
    .query("SELECT * FROM comments WHERE path = ? AND outdated = 1 AND github_resolved = 0")
    .all(path) as Comment[];

  if (comments.length === 0) {
    console.log(`✅ No outdated pending comments for ${path}`);
    return;
  }

  console.log(`🔄 Resolving ${comments.length} outdated comments for ${path}...`);

  for (const comment of comments) {
    await resolveComment(String(comment.id), commit);
  }

  console.log(`✅ Resolved all ${comments.length} comments for ${path}`);
}

async function getFileModifiedTime(path: string): Promise<Date | null> {
  try {
    const file = Bun.file(path);
    if (await file.exists()) {
      return new Date(file.lastModified);
    }
  } catch {}
  return null;
}

async function resolveDeletedFiles(commit: string): Promise<void> {
  const comments = db
    .query("SELECT * FROM comments WHERE outdated = 1 AND github_resolved = 0 ORDER BY path")
    .all() as Comment[];

  if (comments.length === 0) {
    console.log("✅ No outdated pending comments found!");
    return;
  }

  console.log("🔍 Checking for deleted files...\n");

  const deletedFiles = new Map<string, number[]>();

  for (const comment of comments) {
    if (await isFileDeleted(comment.path)) {
      if (!deletedFiles.has(comment.path)) {
        deletedFiles.set(comment.path, []);
      }
      deletedFiles.get(comment.path)!.push(comment.id);
    }
  }

  if (deletedFiles.size === 0) {
    console.log("✅ No outdated comments for deleted files");
    return;
  }

  console.log(`Found ${deletedFiles.size} deleted files with outdated comments:\n`);
  let totalComments = 0;

  for (const [path, ids] of deletedFiles) {
    console.log(`  ${path} (${ids.length} comments)`);
    totalComments += ids.length;
  }

  console.log(`\nTotal: ${totalComments} comments to resolve`);
  console.log(`Commit: ${commit}\n`);

  // Ask for confirmation
  const readline = await import("readline");
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const answer = await new Promise<string>(resolve => {
    rl.question("Proceed with batch resolution? (yes/no): ", resolve);
  });
  rl.close();

  if (answer.toLowerCase() !== "yes" && answer.toLowerCase() !== "y") {
    console.log("❌ Cancelled");
    return;
  }

  console.log("\n🔄 Resolving comments...\n");

  let resolved = 0;
  for (const [path, ids] of deletedFiles) {
    console.log(`Resolving ${ids.length} comments for ${path}...`);
    for (const id of ids) {
      await resolveComment(String(id), commit);
      resolved++;
    }
  }

  console.log(`\n✅ Resolved ${resolved} comments for ${deletedFiles.size} deleted files`);
}

async function verifyOutdated(id: number): Promise<void> {
  const comment = getComment(id);

  if (!comment) {
    console.error(`❌ Comment #${id} not found`);
    process.exit(1);
  }

  if (!comment.outdated) {
    console.log(`⚠️  Comment #${id} is not marked as outdated`);
  }

  if (comment.github_resolved) {
    console.log(`✅ Comment #${id} is already resolved`);
    return;
  }

  // Show comment details
  showComment(String(id));

  // Check if file exists
  console.log("🔍 Verification Info:\n");

  const fileExists = !(await isFileDeleted(comment.path));
  console.log(`   File exists: ${fileExists ? "✅ Yes" : "❌ No (deleted)"}`);

  if (!fileExists) {
    console.log(`\n   💡 File was deleted. Find the deletion commit with:`);
    console.log(`      git log --all --oneline -- ${comment.path} | head -1`);
    return;
  }

  // Check if file was modified after comment was first seen
  const fileModTime = await getFileModifiedTime(comment.path);
  const commentTime = new Date(comment.first_seen);

  if (fileModTime && fileModTime > commentTime) {
    const timeDiff = Math.floor((fileModTime.getTime() - commentTime.getTime()) / 1000 / 60); // minutes
    console.log(
      `   Modified after comment: ⚠️  Yes (${timeDiff < 60 ? timeDiff + "m" : Math.floor(timeDiff / 60) + "h"} later)`,
    );
  } else if (fileModTime) {
    console.log(`   Modified after comment: ✅ No`);
  }

  // Show recent git history for the file
  console.log(`\n   📜 Recent commits for ${comment.path}:`);
  try {
    const result = await $`git log --oneline -5 -- ${comment.path}`.quiet();
    const lines = result.stdout.toString().trim().split("\n");
    for (const line of lines) {
      console.log(`      ${line}`);
    }

    // Suggest the most recent commit
    if (lines.length > 0) {
      const suggestedCommit = lines[0].split(" ")[0];
      console.log(`\n   💡 Suggested commit: ${suggestedCommit}`);
      console.log(`\n   To resolve:`);
      console.log(`      bun discuss.ts resolve ${id} ${suggestedCommit}`);
    }
  } catch (error) {
    console.log(`      (Unable to fetch git history)`);
  }

  console.log();
}

// ============================================================================
// CLI HANDLER
// ============================================================================

function showHelp(): void {
  console.log(`
📝 ${SCRIPT_NAME} - PR Review Comment Manager (Refactored)

USAGE:
  bun ${SCRIPT_NAME} <command> [options]

COMMANDS:
  fetch [pr-number]              Fetch comments from GitHub PR (default: ${DEFAULT_PR})
  list [--priority X]            List all comments, optionally filtered by severity
  search <query> [--show-resolved]  Search comments by text (body or path)
  show <id>...                   Show full details of one or more comments
  note <id> <text>               Add a note/memory to a comment
  reply <id> <text>              Reply to a comment on GitHub, auto-snooze, and refresh
  snooze <id>                    Mark comment as waiting for reply (snoozed)
  unsnooze <id>                  Unmark comment as waiting for reply
  unsnooze-all                   Clear all snoozed statuses at once
  resolve <id>... [commit] [--commit <hash>] [--reply <msg>]
                                 Resolve one or more comments on GitHub
  unresolve <id>                 Unresolve comment on GitHub
  pending [--priority X | --severity X] [--snoozed]
                                 Show unresolved comments (excludes snoozed by default)
  stats                          Show summary statistics
  outdated [--by-file | --count | --deleted-files]
                                 List outdated pending comments
  verify-outdated <id>           Show comprehensive verification info for outdated comment
  resolve-file <path> <commit>   Resolve all outdated comments for a file
  resolve-deleted <commit>       Resolve all comments for deleted files (interactive)
  help                           Show this help message

EXAMPLES:
  bun ${SCRIPT_NAME} fetch
  bun ${SCRIPT_NAME} fetch 23798
  bun ${SCRIPT_NAME} list
  bun ${SCRIPT_NAME} list --priority critical
  bun ${SCRIPT_NAME} search "cleanup active spans"
  bun ${SCRIPT_NAME} search "cleanup" --show-resolved
  bun ${SCRIPT_NAME} pending
  bun ${SCRIPT_NAME} pending --snoozed          # Also show snoozed comments
  bun ${SCRIPT_NAME} pending --priority critical # Show only critical severity
  bun ${SCRIPT_NAME} pending --severity major   # Alternative syntax
  bun ${SCRIPT_NAME} show 2442564379
  bun ${SCRIPT_NAME} show 2442564379 2442763847     # Show multiple comments
  bun ${SCRIPT_NAME} note 2442564379 "Fixed in telemetry.zig"
  bun ${SCRIPT_NAME} reply 2442564379 "This is incorrect - .null is the correct sentinel"
  bun ${SCRIPT_NAME} resolve 2442564379 abc123
  bun ${SCRIPT_NAME} resolve 2442564379 2442763847     # Resolve multiple IDs
  bun ${SCRIPT_NAME} resolve 2442564379 --commit HEAD --reply "Fixed by refactoring the API"
  bun ${SCRIPT_NAME} unresolve 2442564379
  bun ${SCRIPT_NAME} stats

OUTDATED WORKFLOW EXAMPLES:
  bun ${SCRIPT_NAME} outdated                    # List all outdated pending
  bun ${SCRIPT_NAME} outdated --by-file          # Group by file
  bun ${SCRIPT_NAME} outdated --count            # Just show count
  bun ${SCRIPT_NAME} outdated --deleted-files    # Show only deleted files
  bun ${SCRIPT_NAME} verify-outdated 2462702415  # Verify specific comment
  bun ${SCRIPT_NAME} resolve-file packages/bun-otel/src/BunSDK.ts f3305c3e0f
  bun ${SCRIPT_NAME} resolve 2462727818 2463031240 2463031242 e749aa5948  # Resolve multiple IDs
  bun ${SCRIPT_NAME} resolve-deleted e749aa5948  # Batch resolve deleted files

INTEGRATION:
  - Resolution status synced with GitHub (resolving/unresolving updates GitHub)
  - Thread resolution state is fetched from GitHub on every fetch
  - GitHub is the source of truth for resolution status

DATA:
  Comments are stored in ${DB_PATH}
  Each comment tracks: priority, severity, GitHub resolution status, commits, and notes
`);
}

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0] === "help" || args[0] === "--help" || args[0] === "-h") {
    showHelp();
    return;
  }

  const command = args[0];

  switch (command) {
    case "fetch":
      await fetchComments(args[1] || DEFAULT_PR);
      break;

    case "list": {
      const priorityIdx = args.indexOf("--priority");
      const priority = priorityIdx >= 0 ? args[priorityIdx + 1] : undefined;
      listComments(priority);
      break;
    }

    case "search": {
      if (!args[1]) {
        console.error(`❌ Usage: bun ${SCRIPT_NAME} search <query> [--show-resolved]`);
        process.exit(1);
      }
      const showResolved = args.includes("--show-resolved");
      const query = args[1];
      searchComments(query, showResolved);
      break;
    }

    case "show": {
      if (!args[1]) {
        console.error(`❌ Usage: bun ${SCRIPT_NAME} show <id>...`);
        process.exit(1);
      }

      const ids: string[] = [];
      for (let i = 1; i < args.length; i++) {
        const arg = args[i];
        const existsInDb = db.query("SELECT 1 FROM comments WHERE id = ?").get(parseInt(arg)) !== null;
        if (existsInDb) {
          ids.push(arg);
        } else {
          console.warn(`⚠️  Skipping invalid ID: ${arg}`);
        }
      }

      if (ids.length === 0) {
        console.error("❌ No valid comment IDs provided");
        process.exit(1);
      }

      if (ids.length > 1) {
        console.log(`\n📋 Showing ${ids.length} comments: ${ids.join(", ")}`);
        console.log("─".repeat(80));
      }

      for (let i = 0; i < ids.length; i++) {
        showComment(ids[i]);
        if (i < ids.length - 1) {
          console.log("─".repeat(80));
        }
      }
      break;
    }

    case "note":
      if (!args[1] || !args[2]) {
        console.error(`❌ Usage: bun ${SCRIPT_NAME} note <id> <text>`);
        process.exit(1);
      }
      addNote(args[1], args.slice(2).join(" "));
      break;

    case "reply":
      if (!args[1] || !args[2]) {
        console.error(`❌ Usage: bun ${SCRIPT_NAME} reply <id> <text>`);
        process.exit(1);
      }
      await replyToComment(args[1], args.slice(2).join(" "));
      break;

    case "snooze":
      if (!args[1]) {
        console.error(`❌ Usage: bun ${SCRIPT_NAME} snooze <id>`);
        process.exit(1);
      }
      snoozeComment(args[1]);
      break;

    case "unsnooze":
      if (!args[1]) {
        console.error(`❌ Usage: bun ${SCRIPT_NAME} unsnooze <id>`);
        process.exit(1);
      }
      unsnoozeComment(args[1]);
      break;

    case "unsnooze-all":
      unsnoozeAll();
      break;

    case "resolve": {
      if (!args[1]) {
        console.error(`❌ Usage: bun ${SCRIPT_NAME} resolve <id>... [commit] [--commit <hash>] [--reply <message>]`);
        process.exit(1);
      }

      const replyIndex = args.indexOf("--reply");
      const replyMessage = replyIndex !== -1 ? args[replyIndex + 1] : undefined;

      const commitFlagIndex = args.indexOf("--commit");
      let commitHash: string | undefined = commitFlagIndex !== -1 ? args[commitFlagIndex + 1] : undefined;

      const ids: string[] = [];

      for (let i = 1; i < args.length; i++) {
        const arg = args[i];

        if (arg === "--reply" || arg === "--commit") {
          i++;
          continue;
        }
        if (args[i - 1] === "--reply" || args[i - 1] === "--commit") {
          continue;
        }

        const existsInDb = db.query("SELECT 1 FROM comments WHERE id = ?").get(parseInt(arg)) !== null;

        if (existsInDb) {
          ids.push(arg);
        } else if (!commitHash) {
          commitHash = arg;
        }
      }

      if (ids.length === 0) {
        console.error("❌ No valid comment IDs provided");
        process.exit(1);
      }

      for (const id of ids) {
        await resolveComment(id, commitHash, replyMessage);
        if (ids.length > 1) {
          console.log();
        }
      }
      break;
    }

    case "unresolve":
      if (!args[1]) {
        console.error(`❌ Usage: bun ${SCRIPT_NAME} unresolve <id>`);
        process.exit(1);
      }
      await unresolveComment(args[1]);
      break;

    case "pending": {
      const showSnoozed = args.includes("--snoozed");

      const priorityIndex = args.indexOf("--priority");
      const severityIndex = args.indexOf("--severity");
      let severityFilter: string | undefined;

      if (priorityIndex >= 0 && args[priorityIndex + 1]) {
        severityFilter = args[priorityIndex + 1];
      } else if (severityIndex >= 0 && args[severityIndex + 1]) {
        severityFilter = args[severityIndex + 1];
      }

      showPending(severityFilter, showSnoozed);
      break;
    }

    case "stats":
      showStats();
      break;

    case "outdated": {
      const byFile = args.includes("--by-file");
      const count = args.includes("--count");
      const deletedFiles = args.includes("--deleted-files");
      await showOutdatedComments({ byFile, count, deletedFiles });
      break;
    }

    case "verify-outdated": {
      if (!args[1]) {
        console.error("❌ Usage: bun discuss.ts verify-outdated <id>");
        process.exit(1);
      }
      await verifyOutdated(parseInt(args[1]));
      break;
    }

    case "resolve-file": {
      if (!args[1] || !args[2]) {
        console.error("❌ Usage: bun discuss.ts resolve-file <path> <commit>");
        process.exit(1);
      }
      await resolveByFile(args[1], args[2]);
      break;
    }

    case "resolve-deleted": {
      if (!args[1]) {
        console.error("❌ Usage: bun discuss.ts resolve-deleted <commit>");
        process.exit(1);
      }
      await resolveDeletedFiles(args[1]);
      break;
    }

    default:
      console.error(`❌ Unknown command: ${command}`);
      console.log(`   Run "bun ${SCRIPT_NAME} help" for usage information`);
      process.exit(1);
  }
}

// Run!
main().catch(error => {
  console.error("❌ Fatal error:", error);
  process.exit(1);
});

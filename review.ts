#!/usr/bin/env bun
/**
 * review.ts - Interactive PR Review Workflow Manager
 *
 * A stateful, guided workflow tool for systematically reviewing and resolving
 * GitHub PR comments. Makes the review process explicit with clear prompts at each step.
 *
 * Usage:
 *   bun review.ts start [--priority critical]  - Start/resume session
 *   bun review.ts status                       - Show current state
 *   bun review.ts next                         - Move to next comment
 *   bun review.ts batch <name>                 - Start batch mode
 *   bun review.ts add <id>...                  - Add comments to current batch
 *   bun review.ts criteria add <text>          - Add success criterion
 *   bun review.ts commit-msg [edit]            - View/edit commit message
 *   bun review.ts verify                       - Check files are staged
 *   bun review.ts test                         - Run tests
 *   bun review.ts commit                       - Create commit
 */

import { $ } from "bun";
import { Database } from "bun:sqlite";

// ============================================================================
// TYPES & CONSTANTS
// ============================================================================

const REVIEW_DB_PATH = "./review.sqlite";
const DISCUSS_DB_PATH = "./discuss.sqlite";

interface ReviewSession {
  id: number;
  started_at: string;
  last_activity: string;
  status: "active" | "paused" | "completed";
  priority_filter: string | null;
  mode: "sequential" | "batch";
  current_comment_id: number | null;
  current_batch_id: number | null;
  notes: string | null;
}

interface ReviewItem {
  id: number;
  session_id: number;
  comment_id: number;
  state: "queued" | "investigating" | "fixing" | "testing" | "committing" | "done" | "skipped";
  success_criteria: string | null; // JSON array
  context_notes: string | null;
  files_changed: string | null; // JSON array
  test_commands: string | null; // JSON array
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

interface ReviewBatch {
  id: number;
  session_id: number;
  name: string;
  description: string | null;
  strategy: "fix-once" | "design-decision" | "batch-outdated" | "manual" | null;
  comment_ids: string; // JSON array
  success_criteria: string | null; // JSON array
  state: "planning" | "executing" | "testing" | "committing" | "done";
  commit_message: string | null;
  commit_hash: string | null;
  created_at: string;
  updated_at: string;
}

interface Comment {
  id: number;
  path: string;
  line: number | null;
  body: string;
  priority: string;
  severity: string;
  outdated: number;
  github_resolved: number;
  created_at: string;
  updated_at: string;
}

// ============================================================================
// DATABASE SETUP
// ============================================================================

const reviewDb = new Database(REVIEW_DB_PATH);
const discussDb = new Database(DISCUSS_DB_PATH);

function initReviewDatabase(): void {
  reviewDb.run(`
    CREATE TABLE IF NOT EXISTS review_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      started_at TEXT NOT NULL,
      last_activity TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      priority_filter TEXT,
      mode TEXT NOT NULL DEFAULT 'sequential',
      current_comment_id INTEGER,
      current_batch_id INTEGER,
      notes TEXT
    )
  `);

  reviewDb.run(`
    CREATE TABLE IF NOT EXISTS review_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER NOT NULL,
      comment_id INTEGER NOT NULL,
      state TEXT NOT NULL DEFAULT 'queued',
      success_criteria TEXT,
      context_notes TEXT,
      files_changed TEXT,
      test_commands TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT,
      FOREIGN KEY(session_id) REFERENCES review_sessions(id)
    )
  `);

  reviewDb.run(`
    CREATE TABLE IF NOT EXISTS review_batches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      strategy TEXT,
      comment_ids TEXT NOT NULL,
      success_criteria TEXT,
      state TEXT NOT NULL DEFAULT 'planning',
      commit_message TEXT,
      commit_hash TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(session_id) REFERENCES review_sessions(id)
    )
  `);

  reviewDb.run(`
    CREATE INDEX IF NOT EXISTS idx_review_items_session
    ON review_items(session_id)
  `);

  reviewDb.run(`
    CREATE INDEX IF NOT EXISTS idx_review_batches_session
    ON review_batches(session_id)
  `);
}

// ============================================================================
// SESSION MANAGEMENT
// ============================================================================

function getActiveSession(): ReviewSession | null {
  return reviewDb.query("SELECT * FROM review_sessions WHERE status = 'active' LIMIT 1").get() as ReviewSession | null;
}

function createSession(priorityFilter?: string): ReviewSession {
  const now = new Date().toISOString();
  const result = reviewDb.run(
    "INSERT INTO review_sessions (started_at, last_activity, priority_filter) VALUES (?, ?, ?)",
    [now, now, priorityFilter || null],
  );

  return reviewDb.query("SELECT * FROM review_sessions WHERE id = ?").get(result.lastInsertRowid) as ReviewSession;
}

function updateSessionActivity(sessionId: number): void {
  reviewDb.run("UPDATE review_sessions SET last_activity = ? WHERE id = ?", [new Date().toISOString(), sessionId]);
}

function pauseSession(sessionId: number): void {
  reviewDb.run("UPDATE review_sessions SET status = 'paused' WHERE id = ?", [sessionId]);
}

function resumeSession(sessionId: number): void {
  reviewDb.run("UPDATE review_sessions SET status = 'active', last_activity = ? WHERE id = ?", [
    new Date().toISOString(),
    sessionId,
  ]);
}

// ============================================================================
// COMMENT QUERIES (from discuss.sqlite)
// ============================================================================

function getPendingComments(priorityFilter?: string): Comment[] {
  let query = "SELECT * FROM comments WHERE github_resolved = 0 AND outdated = 0 ORDER BY severity, path";
  let params: string[] = [];

  if (priorityFilter) {
    query =
      "SELECT * FROM comments WHERE github_resolved = 0 AND outdated = 0 AND severity = ? ORDER BY severity, path";
    params = [priorityFilter];
  }

  return discussDb.query(query).all(...params) as Comment[];
}

function getComment(id: number): Comment | null {
  return discussDb.query("SELECT * FROM comments WHERE id = ?").get(id) as Comment | null;
}

function getCommentsByIds(ids: number[]): Comment[] {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => "?").join(",");
  return discussDb.query(`SELECT * FROM comments WHERE id IN (${placeholders})`).all(...ids) as Comment[];
}

// ============================================================================
// BATCH MANAGEMENT
// ============================================================================

function createBatch(sessionId: number, name: string, description?: string): ReviewBatch {
  const now = new Date().toISOString();
  const result = reviewDb.run(
    "INSERT INTO review_batches (session_id, name, description, comment_ids, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    [sessionId, name, description || null, "[]", now, now],
  );

  // Update session to batch mode and set current batch
  reviewDb.run("UPDATE review_sessions SET mode = 'batch', current_batch_id = ? WHERE id = ?", [
    result.lastInsertRowid,
    sessionId,
  ]);

  return reviewDb.query("SELECT * FROM review_batches WHERE id = ?").get(result.lastInsertRowid) as ReviewBatch;
}

function getCurrentBatch(sessionId: number): ReviewBatch | null {
  const session = reviewDb.query("SELECT * FROM review_sessions WHERE id = ?").get(sessionId) as ReviewSession | null;
  if (!session || !session.current_batch_id) return null;

  return reviewDb
    .query("SELECT * FROM review_batches WHERE id = ?")
    .get(session.current_batch_id) as ReviewBatch | null;
}

function addCommentsToBatch(batchId: number, commentIds: number[]): void {
  const batch = reviewDb.query("SELECT * FROM review_batches WHERE id = ?").get(batchId) as ReviewBatch;
  const currentIds = JSON.parse(batch.comment_ids) as number[];
  const newIds = [...new Set([...currentIds, ...commentIds])];

  reviewDb.run("UPDATE review_batches SET comment_ids = ?, updated_at = ? WHERE id = ?", [
    JSON.stringify(newIds),
    new Date().toISOString(),
    batchId,
  ]);
}

function removeCommentsFromBatch(batchId: number, commentIds: number[]): void {
  const batch = reviewDb.query("SELECT * FROM review_batches WHERE id = ?").get(batchId) as ReviewBatch;
  const currentIds = JSON.parse(batch.comment_ids) as number[];
  const newIds = currentIds.filter(id => !commentIds.includes(id));

  reviewDb.run("UPDATE review_batches SET comment_ids = ?, updated_at = ? WHERE id = ?", [
    JSON.stringify(newIds),
    new Date().toISOString(),
    batchId,
  ]);
}

// ============================================================================
// SUCCESS CRITERIA MANAGEMENT
// ============================================================================

function addCriteria(batchId: number, criterion: string): void {
  const batch = reviewDb.query("SELECT * FROM review_batches WHERE id = ?").get(batchId) as ReviewBatch;
  const criteria = batch.success_criteria ? (JSON.parse(batch.success_criteria) as string[]) : [];
  criteria.push(criterion);

  reviewDb.run("UPDATE review_batches SET success_criteria = ?, updated_at = ? WHERE id = ?", [
    JSON.stringify(criteria),
    new Date().toISOString(),
    batchId,
  ]);
}

function listCriteria(batchId: number): string[] {
  const batch = reviewDb.query("SELECT * FROM review_batches WHERE id = ?").get(batchId) as ReviewBatch;
  return batch.success_criteria ? (JSON.parse(batch.success_criteria) as string[]) : [];
}

function checkCriteria(batchId: number, index: number): void {
  const batch = reviewDb.query("SELECT * FROM review_batches WHERE id = ?").get(batchId) as ReviewBatch;
  const criteria = batch.success_criteria ? (JSON.parse(batch.success_criteria) as string[]) : [];

  if (index >= 0 && index < criteria.length) {
    criteria[index] = "✅ " + criteria[index].replace(/^[✅❌]\s*/, "");
    reviewDb.run("UPDATE review_batches SET success_criteria = ?, updated_at = ? WHERE id = ?", [
      JSON.stringify(criteria),
      new Date().toISOString(),
      batchId,
    ]);
  }
}

function uncheckCriteria(batchId: number, index: number): void {
  const batch = reviewDb.query("SELECT * FROM review_batches WHERE id = ?").get(batchId) as ReviewBatch;
  const criteria = batch.success_criteria ? (JSON.parse(batch.success_criteria) as string[]) : [];

  if (index >= 0 && index < criteria.length) {
    criteria[index] = "❌ " + criteria[index].replace(/^[✅❌]\s*/, "");
    reviewDb.run("UPDATE review_batches SET success_criteria = ?, updated_at = ? WHERE id = ?", [
      JSON.stringify(criteria),
      new Date().toISOString(),
      batchId,
    ]);
  }
}

function allCriteriaComplete(batchId: number): boolean {
  const criteria = listCriteria(batchId);
  if (criteria.length === 0) return false; // No criteria = not ready
  return criteria.every(c => c.startsWith("✅"));
}

function getIncompleteCriteria(batchId: number): string[] {
  const criteria = listCriteria(batchId);
  return criteria
    .map((c, i) => ({ text: c, index: i + 1 }))
    .filter(({ text }) => !text.startsWith("✅"))
    .map(({ text, index }) => `${index}. ${text.replace(/^[✅❌⬜]\s*/, "")}`);
}

// ============================================================================
// COMMIT MESSAGE MANAGEMENT
// ============================================================================

function getCommitMessage(batchId: number): string | null {
  const batch = reviewDb.query("SELECT * FROM review_batches WHERE id = ?").get(batchId) as ReviewBatch;
  return batch.commit_message;
}

function setCommitMessage(batchId: number, message: string): void {
  reviewDb.run("UPDATE review_batches SET commit_message = ?, updated_at = ? WHERE id = ?", [
    message,
    new Date().toISOString(),
    batchId,
  ]);
}

async function editCommitMessage(batchId: number): Promise<void> {
  const currentMessage = getCommitMessage(batchId) || "";
  const tmpFile = `/tmp/review-commit-msg-${batchId}.txt`;

  await Bun.write(tmpFile, currentMessage);

  const editor = process.env.EDITOR || "vim";
  await $`${editor} ${tmpFile}`.quiet();

  const newMessage = await Bun.file(tmpFile).text();
  setCommitMessage(batchId, newMessage.trim());

  console.log("✅ Commit message updated");
}

// ============================================================================
// FILE VERIFICATION
// ============================================================================

async function verifyFilesStaged(commentIds: number[]): Promise<{
  allStaged: boolean;
  missingFiles: string[];
  stagedFiles: string[];
}> {
  const comments = getCommentsByIds(commentIds);
  const commentFiles = [...new Set(comments.map(c => c.path))];

  // Get git status
  const result = await $`git status --porcelain`.quiet();
  const statusLines = result.stdout.toString().trim().split("\n");

  const stagedFiles = statusLines
    .filter(line => line.match(/^[MARC]/)) // Staged changes
    .map(line => line.substring(3).trim());

  const missingFiles = commentFiles.filter(file => !stagedFiles.includes(file));

  return {
    allStaged: missingFiles.length === 0,
    missingFiles,
    stagedFiles: stagedFiles.filter(file => commentFiles.includes(file)),
  };
}

// ============================================================================
// DISPLAY FUNCTIONS
// ============================================================================

function displaySessionStatus(session: ReviewSession): void {
  console.log("\n" + "━".repeat(80));
  console.log(`📊 Review Session #${session.id}`);
  console.log("━".repeat(80));
  console.log(`Status: ${session.status === "active" ? "🟢 Active" : "⏸️  Paused"}`);
  console.log(`Mode: ${session.mode === "batch" ? "📦 Batch" : "📝 Sequential"}`);
  console.log(`Started: ${new Date(session.started_at).toLocaleString()}`);
  console.log(`Last activity: ${new Date(session.last_activity).toLocaleString()}`);

  if (session.priority_filter) {
    console.log(`Priority filter: ${session.priority_filter}`);
  }

  if (session.mode === "batch" && session.current_batch_id) {
    displayBatchStatus(session.current_batch_id);
  }
}

function displayBatchStatus(batchId: number): void {
  const batch = reviewDb.query("SELECT * FROM review_batches WHERE id = ?").get(batchId) as ReviewBatch;
  const commentIds = JSON.parse(batch.comment_ids) as number[];
  const comments = getCommentsByIds(commentIds);

  console.log("\n" + "─".repeat(80));
  console.log(`📦 Batch: ${batch.name}`);
  console.log("─".repeat(80));

  if (batch.description) {
    console.log(`Description: ${batch.description}`);
  }

  console.log(`State: ${batch.state}`);
  console.log(`Strategy: ${batch.strategy || "manual"}`);
  console.log(`Comments: ${commentIds.length}`);

  // Show comment summary
  console.log("\n📝 Comments in batch:");
  for (const comment of comments) {
    const statusIcon = comment.outdated ? "⚠️ " : comment.github_resolved ? "✅" : "⏳";
    const priorityIcon = getPriorityIcon(comment.priority);
    const severityIcon = getSeverityIcon(comment.severity);
    console.log(
      `  ${statusIcon} [${comment.id}] ${priorityIcon} ${severityIcon} ${comment.path}:${comment.line || "?"}`,
    );
  }

  // Show success criteria
  const criteria = listCriteria(batchId);
  if (criteria.length > 0) {
    console.log("\n✓ Success Criteria:");
    criteria.forEach((c, i) => {
      const prefix = c.startsWith("✅") || c.startsWith("❌") ? "" : "⬜ ";
      console.log(`  ${i + 1}. ${prefix}${c.replace(/^[✅❌]\s*/, "")}`);
    });
  }

  // Show commit message if set
  if (batch.commit_message) {
    console.log("\n💬 Commit Message:");
    console.log(
      batch.commit_message
        .split("\n")
        .map(line => `  ${line}`)
        .join("\n"),
    );
  }
}

function getPriorityIcon(priority: string): string {
  const icons: Record<string, string> = {
    issue: "⚠️ ",
    refactor: "🛠️ ",
    nitpick: "🧹",
    unknown: "❓",
  };
  return icons[priority] || "❓";
}

function getSeverityIcon(severity: string): string {
  const icons: Record<string, string> = {
    critical: "🔴",
    major: "🟠",
    minor: "🟡",
    trivial: "🔵",
    unknown: "⚪",
  };
  return icons[severity] || "⚪";
}

// ============================================================================
// WORKFLOW COMMANDS
// ============================================================================

async function startSession(args: string[]): Promise<void> {
  const priorityFilter = args.includes("--priority") ? args[args.indexOf("--priority") + 1] : undefined;

  let session = getActiveSession();

  if (session) {
    console.log("📝 Resuming existing session...");
    resumeSession(session.id);
    session = getActiveSession()!;
  } else {
    console.log("🚀 Starting new review session...");
    session = createSession(priorityFilter);
  }

  displaySessionStatus(session);

  // Show available comments
  const pending = getPendingComments(priorityFilter);
  console.log(`\n📋 ${pending.length} pending comments available`);
  console.log("\nNext steps:");
  console.log("  bun review.ts next           - Review next comment");
  console.log("  bun review.ts batch <name>   - Start batch mode");
  console.log("  bun review.ts status         - Show current status");
}

async function showStatus(): Promise<void> {
  const session = getActiveSession();

  if (!session) {
    console.log("❌ No active session");
    console.log("\nStart a session:");
    console.log("  bun review.ts start [--priority critical]");
    return;
  }

  displaySessionStatus(session);
}

async function startBatch(name: string, description?: string): Promise<void> {
  const session = getActiveSession();

  if (!session) {
    console.log("❌ No active session. Start one first:");
    console.log("  bun review.ts start");
    return;
  }

  const batch = createBatch(session.id, name, description);
  console.log(`✅ Created batch: ${name}`);
  console.log(`\nBatch ID: ${batch.id}`);
  console.log("\nNext steps:");
  console.log(`  bun review.ts add <id>...     - Add comments to batch`);
  console.log(`  bun review.ts criteria add <text> - Add success criteria`);
  console.log(`  bun review.ts status          - Show batch status`);
}

async function addComments(args: string[]): Promise<void> {
  const session = getActiveSession();
  if (!session) {
    console.log("❌ No active session");
    return;
  }

  const batch = getCurrentBatch(session.id);
  if (!batch) {
    console.log("❌ No active batch. Start one first:");
    console.log("  bun review.ts batch <name>");
    return;
  }

  const commentIds = args.map(arg => parseInt(arg)).filter(id => !isNaN(id));

  if (commentIds.length === 0) {
    console.log("❌ No valid comment IDs provided");
    return;
  }

  addCommentsToBatch(batch.id, commentIds);
  updateSessionActivity(session.id);

  console.log(`✅ Added ${commentIds.length} comment(s) to batch "${batch.name}"`);
  console.log("\nCurrent batch:");
  displayBatchStatus(batch.id);
}

async function manageCriteria(action: string, args: string[]): Promise<void> {
  const session = getActiveSession();
  if (!session) {
    console.log("❌ No active session");
    return;
  }

  const batch = getCurrentBatch(session.id);
  if (!batch) {
    console.log("❌ No active batch");
    return;
  }

  if (action === "add") {
    const criterion = args.join(" ");
    if (!criterion) {
      console.log("❌ No criterion text provided");
      return;
    }
    addCriteria(batch.id, criterion);
    console.log("✅ Added success criterion");
  } else if (action === "list") {
    const criteria = listCriteria(batch.id);
    if (criteria.length === 0) {
      console.log("No success criteria yet");
      return;
    }
    console.log("\n✓ Success Criteria:");
    criteria.forEach((c, i) => {
      const prefix = c.startsWith("✅") || c.startsWith("❌") ? "" : "⬜ ";
      console.log(`  ${i + 1}. ${prefix}${c.replace(/^[✅❌]\s*/, "")}`);
    });
  } else if (action === "check" || action === "uncheck") {
    const index = parseInt(args[0]);
    if (isNaN(index) || index < 1) {
      console.log("❌ Invalid criterion index");
      return;
    }
    if (action === "check") {
      checkCriteria(batch.id, index - 1);
      console.log("✅ Marked criterion as complete");
    } else {
      uncheckCriteria(batch.id, index - 1);
      console.log("❌ Marked criterion as incomplete");
    }
  }

  updateSessionActivity(session.id);
}

async function manageCommitMessage(args: string[]): Promise<void> {
  const session = getActiveSession();
  if (!session) {
    console.log("❌ No active session");
    return;
  }

  const batch = getCurrentBatch(session.id);
  if (!batch) {
    console.log("❌ No active batch");
    return;
  }

  if (args[0] === "edit") {
    await editCommitMessage(batch.id);
  } else if (args[0] === "set") {
    const message = args.slice(1).join(" ");
    setCommitMessage(batch.id, message);
    console.log("✅ Commit message set");
  } else {
    // View current message
    const message = getCommitMessage(batch.id);
    if (!message) {
      console.log("No commit message set yet");
      console.log("\nSet message:");
      console.log("  bun review.ts commit-msg set <message>");
      console.log("  bun review.ts commit-msg edit");
    } else {
      console.log("\n💬 Current Commit Message:");
      console.log("─".repeat(80));
      console.log(message);
      console.log("─".repeat(80));
      console.log("\nEdit:");
      console.log("  bun review.ts commit-msg edit");
    }
  }

  updateSessionActivity(session.id);
}

async function verifyFiles(): Promise<void> {
  const session = getActiveSession();
  if (!session) {
    console.log("❌ No active session");
    return;
  }

  const batch = getCurrentBatch(session.id);
  if (!batch) {
    console.log("❌ No active batch");
    return;
  }

  const commentIds = JSON.parse(batch.comment_ids) as number[];
  const { allStaged, missingFiles, stagedFiles } = await verifyFilesStaged(commentIds);

  console.log("\n🔍 File Verification");
  console.log("─".repeat(80));

  if (stagedFiles.length > 0) {
    console.log("\n✅ Staged files from comments:");
    stagedFiles.forEach(file => console.log(`  ${file}`));
  }

  if (missingFiles.length > 0) {
    console.log("\n⚠️  Files mentioned in comments but NOT staged:");
    missingFiles.forEach(file => console.log(`  ${file}`));
  }

  if (allStaged) {
    console.log("\n✅ All comment files are staged!");
  } else {
    console.log("\n⚠️  Some files are not staged. Review before committing.");
  }

  updateSessionActivity(session.id);
}

async function checkReadiness(): Promise<void> {
  const session = getActiveSession();
  if (!session) {
    console.log("❌ No active session");
    console.log("\n💡 Start a session:");
    console.log("  bun review.ts start [--priority critical]");
    return;
  }

  const batch = getCurrentBatch(session.id);
  if (!batch) {
    console.log("❌ No active batch");
    console.log("\n💡 Create a batch:");
    console.log("  bun review.ts batch <name> [description]");
    return;
  }

  console.log("\n🔍 Readiness Check");
  console.log("━".repeat(80));

  const commentIds = JSON.parse(batch.comment_ids) as number[];
  const hasComments = commentIds.length > 0;
  const hasCriteria = listCriteria(batch.id).length > 0;
  const allComplete = allCriteriaComplete(batch.id);
  const hasCommitMessage = !!getCommitMessage(batch.id);
  const { allStaged } = await verifyFilesStaged(commentIds);

  // Check 1: Comments
  if (hasComments) {
    console.log(`✅ Comments: ${commentIds.length} comment(s) in batch`);
  } else {
    console.log("❌ Comments: No comments added yet");
    console.log("   → bun review.ts add <id>...");
  }

  // Check 2: Success criteria
  if (hasCriteria) {
    if (allComplete) {
      console.log("✅ Criteria: All complete");
    } else {
      const incomplete = getIncompleteCriteria(batch.id);
      console.log(`⚠️  Criteria: ${incomplete.length} incomplete`);
      console.log("   Incomplete:");
      incomplete.forEach(c => console.log(`   - ${c}`));
      console.log("   → bun review.ts criteria check <n>");
    }
  } else {
    console.log("⚠️  Criteria: No success criteria defined");
    console.log("   → bun review.ts criteria add <text>");
  }

  // Check 3: Commit message
  if (hasCommitMessage) {
    console.log("✅ Commit message: Set");
  } else {
    console.log("❌ Commit message: Not set");
    console.log("   → bun review.ts commit-msg set <message>");
    console.log("   → bun review.ts commit-msg edit");
  }

  // Check 4: Files staged
  if (hasComments) {
    if (allStaged) {
      console.log("✅ Files: All comment files are staged");
    } else {
      console.log("⚠️  Files: Some comment files not staged");
      console.log("   → git add <files>");
      console.log("   → bun review.ts verify (for details)");
    }
  }

  console.log("\n" + "━".repeat(80));

  const ready = hasComments && hasCriteria && allComplete && hasCommitMessage && allStaged;

  if (ready) {
    console.log("✅ READY TO COMMIT!");
    console.log("\n💡 Next step:");
    console.log("  bun review.ts commit");
  } else {
    console.log("⚠️  NOT READY - Complete the items above");
  }

  updateSessionActivity(session.id);
}

async function commitBatch(): Promise<void> {
  const session = getActiveSession();
  if (!session) {
    console.log("❌ No active session");
    return;
  }

  const batch = getCurrentBatch(session.id);
  if (!batch) {
    console.log("❌ No active batch");
    return;
  }

  // Pre-flight checks
  const commentIds = JSON.parse(batch.comment_ids) as number[];
  const hasComments = commentIds.length > 0;
  const allComplete = allCriteriaComplete(batch.id);
  const commitMessage = getCommitMessage(batch.id);
  const { allStaged, missingFiles } = await verifyFilesStaged(commentIds);

  console.log("\n🚀 Commit Pre-flight Check");
  console.log("━".repeat(80));

  // Validation
  const issues: string[] = [];

  if (!hasComments) {
    issues.push("No comments in batch");
  }

  if (!allComplete) {
    const incomplete = getIncompleteCriteria(batch.id);
    issues.push(`${incomplete.length} incomplete criteria:`);
    incomplete.forEach(c => issues.push(`  - ${c}`));
  }

  if (!commitMessage) {
    issues.push("No commit message set");
  }

  if (!allStaged) {
    issues.push(`${missingFiles.length} files not staged:`);
    missingFiles.forEach(f => issues.push(`  - ${f}`));
  }

  if (issues.length > 0) {
    console.log("❌ Cannot commit - issues found:\n");
    issues.forEach(issue => console.log(`  ${issue}`));
    console.log("\n💡 Check readiness:");
    console.log("  bun review.ts ready");
    return;
  }

  // All checks passed - show summary
  console.log(`✅ Comments: ${commentIds.length}`);
  console.log("✅ Criteria: All complete");
  console.log("✅ Commit message: Set");
  console.log("✅ Files: All staged");

  console.log("\n💬 Commit message:");
  console.log("─".repeat(80));
  console.log(commitMessage);
  console.log("─".repeat(80));

  // Prompt for confirmation
  const readline = await import("readline");
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const answer = await new Promise<string>(resolve => {
    rl.question("\nProceed with commit? (yes/no): ", resolve);
  });
  rl.close();

  if (answer.toLowerCase() !== "yes" && answer.toLowerCase() !== "y") {
    console.log("❌ Cancelled");
    return;
  }

  // Create commit
  console.log("\n💾 Creating commit...");

  try {
    const result = await $`git commit -m ${commitMessage}`;

    // Get commit hash
    const hashResult = await $`git rev-parse HEAD`.quiet();
    const commitHash = hashResult.stdout.toString().trim();

    // Update batch
    reviewDb.run("UPDATE review_batches SET state = 'done', commit_hash = ?, updated_at = ? WHERE id = ?", [
      commitHash,
      new Date().toISOString(),
      batch.id,
    ]);

    console.log(`✅ Committed: ${commitHash.substring(0, 10)}`);
    console.log("\n💡 Next steps:");
    console.log("  1. Review the commit: git show");
    console.log(`  2. Resolve comments on GitHub: bun discuss.ts resolve ${commentIds.join(" ")} ${commitHash}`);
    console.log("  3. Push when ready: git push");
    console.log("  4. Start next batch: bun review.ts batch <name>");

    updateSessionActivity(session.id);
  } catch (error: any) {
    console.error("❌ Commit failed:", error.message);
    console.log("\n💡 Check git status:");
    console.log("  git status");
  }
}

// ============================================================================
// CLI HANDLER
// ============================================================================

function showHelp(): void {
  console.log(`
📝 review.ts - Interactive PR Review Workflow Manager

USAGE:
  bun review.ts <command> [options]

SESSION COMMANDS:
  start [--priority X]       Start or resume review session
  status                     Show current session status
  pause                      Pause current session
  reset                      Reset and start fresh

BATCH COMMANDS:
  batch <name> [description] Start batch mode with name
  add <id>...                Add comment IDs to current batch
  remove <id>...             Remove comment IDs from current batch

SUCCESS CRITERIA:
  criteria add <text>        Add a success criterion
  criteria list              List all criteria
  criteria check <n>         Mark criterion N as complete
  criteria uncheck <n>       Mark criterion N as incomplete

COMMIT MANAGEMENT:
  commit-msg                 View current commit message
  commit-msg set <msg>       Set commit message
  commit-msg edit            Edit commit message in $EDITOR

VERIFICATION & COMMIT:
  verify                     Check that comment files are staged
  ready                      Check if batch is ready to commit
  commit                     Create git commit (validates criteria first)
  status                     Show status of all batch comments

EXAMPLES:
  # Start a session focusing on critical issues
  bun review.ts start --priority critical

  # Create a batch for memory leak fixes
  bun review.ts batch "memory-leaks" "Fix all shutdown cleanup issues"

  # Add comments to the batch
  bun review.ts add 2442564379 2442564380 2442564381

  # Set success criteria
  bun review.ts criteria add "All shutdown() methods clear references"
  bun review.ts criteria add "No memory leaks in tests"
  bun review.ts criteria add "Tests pass for all modified files"

  # Mark criteria complete
  bun review.ts criteria check 1

  # Set commit message
  bun review.ts commit-msg set "fix(bun-otel): clear references in shutdown methods"

  # Or edit in $EDITOR
  bun review.ts commit-msg edit

  # Verify files before committing
  bun review.ts verify

  # Check overall status
  bun review.ts status

WORKFLOW:
  1. Start session → 2. Create batch → 3. Add comments → 4. Set criteria
  → 5. Fix issues → 6. Verify files → 7. Review criteria → 8. Commit
`);
}

async function main(): Promise<void> {
  initReviewDatabase();

  const args = process.argv.slice(2);
  const command = args[0];

  if (!command || command === "help") {
    showHelp();
    return;
  }

  switch (command) {
    case "start":
      await startSession(args.slice(1));
      break;

    case "status":
      await showStatus();
      break;

    case "pause": {
      const session = getActiveSession();
      if (session) {
        pauseSession(session.id);
        console.log("⏸️  Session paused");
      } else {
        console.log("❌ No active session");
      }
      break;
    }

    case "batch": {
      if (!args[1]) {
        console.log("❌ Batch name required");
        console.log("Usage: bun review.ts batch <name> [description]");
        break;
      }
      await startBatch(args[1], args.slice(2).join(" "));
      break;
    }

    case "add":
      await addComments(args.slice(1));
      break;

    case "remove": {
      const session = getActiveSession();
      if (!session) {
        console.log("❌ No active session");
        break;
      }
      const batch = getCurrentBatch(session.id);
      if (!batch) {
        console.log("❌ No active batch");
        break;
      }
      const commentIds = args
        .slice(1)
        .map(arg => parseInt(arg))
        .filter(id => !isNaN(id));
      removeCommentsFromBatch(batch.id, commentIds);
      console.log(`✅ Removed ${commentIds.length} comment(s)`);
      break;
    }

    case "criteria":
      await manageCriteria(args[1], args.slice(2));
      break;

    case "commit-msg":
      await manageCommitMessage(args.slice(1));
      break;

    case "verify":
      await verifyFiles();
      break;

    case "ready":
      await checkReadiness();
      break;

    case "commit":
      await commitBatch();
      break;

    default:
      console.error(`❌ Unknown command: ${command}`);
      console.log('   Run "bun review.ts help" for usage information');
      process.exit(1);
  }
}

main().catch(error => {
  console.error("❌ Error:", error.message);
  process.exit(1);
});

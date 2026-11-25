import type { PluginClient, ToolDeps } from "../types"
import { requireLead, checkWorktreeDirty, countBranchCommits } from "./shared"
import type { IsDirtyFn, CommitCountFn } from "./shared"
import { getTeamResourceParts, preserveBranch, preservedBranchName, resolveMemberRef } from "./merge-helper"
import type { PreserveBranchFn } from "./merge-helper"
import { releaseMemberTasks } from "../tasks"
import { log } from "../log"

/**
 * Execute the team_shutdown tool. Requests a teammate to shut down.
 *
 * Before aborting, preserves the worktree branch to a safe ref so
 * session.abort() cannot destroy the agent's committed work.
 */
export async function executeTeamShutdown(
  deps: ToolDeps,
  args: { member: string; force?: boolean },
  sessionId: string,
  isDirty: IsDirtyFn = checkWorktreeDirty,
  preserve: PreserveBranchFn = preserveBranch,
  commitCount: CommitCountFn = countBranchCommits,
): Promise<string> {
  const teamInfo = requireLead(deps, sessionId)

  const member = deps.db.query("SELECT session_id, status, worktree_branch, worktree_dir FROM team_member WHERE team_id = ? AND name = ?")
    .get(teamInfo.teamId, args.member) as { session_id: string; status: string; worktree_branch: string | null; worktree_dir: string | null } | null
  if (!member) throw new Error(`Teammate "${args.member}" not found in team "${teamInfo.teamName}"`)
  if (member.status === "shutdown") throw new Error(`Teammate "${args.member}" is already shut down`)

  const force = args.force ?? false

  const alreadyRequested = member.status === "shutdown_requested"
  const isIdle = !alreadyRequested && !force && (deps.v2
    ? member.status !== "busy"
    : await v1SessionIdle(deps.client, member.session_id))
  if (alreadyRequested || isIdle || force) {
    if (deps.v2) {
      const error = await stopV2Member(deps, teamInfo.teamId, args.member, member.session_id)
      if (error) return `Could not stop "${args.member}": ${error}`
    } else {
      await preserveAndAbort(deps, teamInfo.teamId, args.member, member.session_id, member.worktree_branch, preserve)
    }
    const status = await getBranchStatus(deps, teamInfo.teamId, args.member, member.worktree_dir, isDirty, commitCount)
    const result = alreadyRequested ? `Force shut down "${args.member}".` : `Teammate "${args.member}" has been shut down.`
    return result + status
  }

  // Busy + not force → graceful: preserve branch first, then send shutdown message
  // Branch must be preserved NOW — if the session crashes during shutdown_requested,
  // the worktree and branch could be lost before force-abort ever runs.
  if (!deps.v2 && member.worktree_branch) {
    const resource = getTeamResourceParts(deps.db, teamInfo.teamId)
    const safeBranch = preservedBranchName(resource.projectName, resource.teamName, resource.teamId, args.member)
    const ok = await preserve(member.worktree_branch, safeBranch, deps.directory)
    if (ok) {
      deps.db.run(
        "UPDATE team_member SET worktree_branch = ? WHERE team_id = ? AND name = ?",
        [safeBranch, teamInfo.teamId, args.member],
      )
      log(`shutdown:branch:preserved-graceful src=${member.worktree_branch} target=${safeBranch}`)
    }
  }

  try {
    deps.client.session.promptAsync({
      sessionID: member.session_id,
      parts: [{
        type: "text",
        text: `[Shutdown requested]: The lead has requested you shut down. Finish your current task, send your final findings to the lead via team_message, then stop.`,
      }],
    }).catch(() => { /* fire-and-forget */ })
  } catch {
    // promptAsync failed — best effort
  }

  deps.db.run(
    "UPDATE team_member SET status = 'shutdown_requested', time_updated = ? WHERE team_id = ? AND name = ?",
    [Date.now(), teamInfo.teamId, args.member],
  )

  return `Shutdown requested for ${args.member}. They will finish current work and shut down. Call team_shutdown with force: true to abort immediately.`
}

async function v1SessionIdle(client: PluginClient, sessionId: string): Promise<boolean> {
  try {
    if (!client.session.status) return false
    const status = (await client.session.status()).data?.[sessionId]
    return !status || status.type === "idle"
  } catch {
    return false
  }
}

/** Confirm the foreground drain finished before inspecting or removing its worktree. */
export async function confirmStopped(client: PluginClient, sessionId: string): Promise<boolean> {
  try {
    if (!client.session.wait) return false
    await client.session.wait({ sessionID: sessionId })
    return true
  } catch {
    return false
  }
}

export async function stopV2Member(deps: ToolDeps, teamId: string, name: string, sessionId: string): Promise<string | undefined> {
  let interruptError: string | undefined
  try {
    await deps.client.session.abort({ sessionID: sessionId })
  } catch (err) {
    interruptError = err instanceof Error ? err.message : String(err)
    log(`shutdown:interrupt-failed team=${teamId} member=${name} err=${interruptError}`)
  }
  if (!await confirmStopped(deps.client, sessionId)) {
    return interruptError ?? "OpenCode could not confirm the session stopped."
  }
  recordShutdown(deps, teamId, name)
  return undefined
}

/**
 * Preserve the worktree branch, then abort the session and mark shutdown.
 * The branch is copied to ensemble/preserved/{team_id}/{name} BEFORE abort,
 * so session.abort() cannot destroy the agent's committed work.
 */
async function preserveAndAbort(
  deps: ToolDeps,
  teamId: string,
  memberName: string,
  sessionId: string,
  worktreeBranch: string | null,
  preserve: PreserveBranchFn,
): Promise<void> {
  // Preserve the branch BEFORE aborting — session.abort() may delete the worktree + branch
  if (worktreeBranch && !worktreeBranch.startsWith("ensemble/preserved/")) {
    const resource = getTeamResourceParts(deps.db, teamId)
    const safeBranch = preservedBranchName(resource.projectName, resource.teamName, resource.teamId, memberName)
    const ok = await preserve(worktreeBranch, safeBranch, deps.directory)
    if (ok) {
      deps.db.run(
        "UPDATE team_member SET worktree_branch = ? WHERE team_id = ? AND name = ?",
        [safeBranch, teamId, memberName],
      )
      log(`shutdown:branch:preserved src=${worktreeBranch} target=${safeBranch}`)
    } else {
      log(`shutdown:branch:preserve-failed src=${worktreeBranch} target=${safeBranch}`)
    }
  }

  // Now safe to abort — the branch is preserved
  try {
    await deps.client.session.abort({ sessionID: sessionId })
  } catch {
    // Abort failed — session may already be gone
  }

  recordShutdown(deps, teamId, memberName)
}

function recordShutdown(deps: ToolDeps, teamId: string, memberName: string): void {
  deps.db.run(
    "UPDATE team_member SET status = 'shutdown', execution_status = 'idle', time_updated = ? WHERE team_id = ? AND name = ?",
    [Date.now(), teamId, memberName],
  )

  // Release any tasks this member was working — they are gone now, so their
  // in_progress work must return to the pool for another teammate (issue #27).
  const released = releaseMemberTasks(deps.db, teamId, memberName)
  if (released > 0) log(`shutdown:tasks:released name=${memberName} count=${released}`)
}

/** Build a status line describing the teammate's work: commit count, dirty state, next step. */
async function getBranchStatus(
  deps: ToolDeps,
  teamId: string,
  memberName: string,
  worktreeDir: string | null,
  isDirty: IsDirtyFn,
  commitCount: CommitCountFn,
): Promise<string> {
  const row = deps.db.query("SELECT worktree_branch FROM team_member WHERE team_id = ? AND name = ?")
    .get(teamId, memberName) as { worktree_branch: string | null } | null
  if (!row?.worktree_branch) return ""

  const branch = row.worktree_branch
  const parts: string[] = []

  const ref = deps.v2 ? await resolveMemberRef({ worktree_dir: worktreeDir, worktree_branch: branch }) : branch
  const commits = ref ? await commitCount(ref, deps.directory) : -1
  // Best-effort dirty check — worktree may already be deleted by session.abort() race
  const dirty = worktreeDir ? await isDirty(worktreeDir).catch(() => false) : false

  if (commits > 0 && dirty) {
    parts.push(`${memberName} committed ${commits} change${commits !== 1 ? "s" : ""} and has uncommitted work.`)
  } else if (commits > 0) {
    parts.push(`${memberName} committed ${commits} change${commits !== 1 ? "s" : ""}. Ready to merge.`)
  } else if (dirty) {
    parts.push(`${memberName} has uncommitted changes only — their work may be incomplete.`)
  } else if (commits < 0) {
    parts.push(`Could not determine ${memberName}'s commit status. Merge to check their work.`)
  } else {
    parts.push(`${memberName} made no changes.`)
  }

  parts.push(`Branch: ${branch}`)
  parts.push("Use team_merge to merge their work.")
  return `\n${parts.join("\n")}`
}

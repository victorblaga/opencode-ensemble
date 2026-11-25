import type { Database } from "./db"
import { log } from "./log"
import { sendMessage } from "./messaging"
import { releaseMemberTasks } from "./tasks"

export type Ownership = "mine" | "orphaned" | "foreign"

export function pidAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid < 1) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM"
  }
}

function teamHost(db: Database, teamId: string): { name: string; host_pid: number | null } | null {
  return db.query("SELECT name, host_pid FROM team WHERE id = ? AND status = 'active'")
    .get(teamId) as ReturnType<typeof teamHost>
}

export function teamOwnership(db: Database, teamId: string, alive = pidAlive): Ownership {
  const pid = teamHost(db, teamId)?.host_pid
  if (pid === process.pid) return "mine"
  return pid && alive(pid) ? "foreign" : "orphaned"
}

/** Adopt an orphaned team and recover all interrupted members in the same transaction. */
export function claimTeam(db: Database, teamId: string): { claimed: boolean; interrupted: string[] } {
  const host = teamHost(db, teamId)
  if (!host || (host.host_pid !== null && pidAlive(host.host_pid))) return { claimed: false, interrupted: [] }

  const result = db.transaction(() => {
    const now = Date.now()
    const changed = db.run(
      "UPDATE team SET host_pid = ?, lead_status = 'busy', time_updated = ? WHERE id = ? AND status = 'active' AND host_pid IS ?",
      [process.pid, now, teamId, host.host_pid],
    ).changes
    if (!changed) return { claimed: false, interrupted: [] }

    const members = db.query("SELECT name, status FROM team_member WHERE team_id = ? AND status IN ('busy', 'shutdown_requested')")
      .all(teamId) as Array<{ name: string; status: string }>
    for (const member of members) {
      const stopping = member.status === "shutdown_requested"
      db.run(
        "UPDATE team_member SET status = ?, execution_status = 'cancelled', time_updated = ?, retry_until = NULL WHERE team_id = ? AND name = ?",
        [stopping ? "shutdown" : "ready", now, teamId, member.name],
      )
      if (stopping) releaseMemberTasks(db, teamId, member.name)
    }
    const interrupted = members.map(member => member.name)
    if (interrupted.length) {
      sendMessage(db, {
        teamId, from: "system", to: "lead",
        content: `The previous OpenCode server stopped. Interrupted teammates: ${interrupted.join(", ")}. Their sessions and worktrees are intact. Use team_message to continue available teammates, or shut them down and merge their work.`,
      })
    }
    return { claimed: true, interrupted }
  })()
  if (result.claimed) log(`host:adopted team=${teamId} interrupted=${result.interrupted.join(",")}`)
  return result
}

export function requireHostedHere(db: Database, teamId: string, role: "lead" | "member"): void {
  let ownership = teamOwnership(db, teamId)
  if (ownership === "orphaned" && role === "lead") {
    claimTeam(db, teamId)
    ownership = teamOwnership(db, teamId)
  }
  if (ownership === "mine") return
  if (ownership === "orphaned") throw new Error("This team's server stopped; the lead has to return first.")
  const host = teamHost(db, teamId)
  log(`host:refused team=${teamId} owner=${host?.host_pid}`)
  throw new Error(`Team "${host?.name}" is hosted by another OpenCode server (pid ${host?.host_pid}). This session is running on server pid ${process.pid}, so team tools are disabled here.`)
}

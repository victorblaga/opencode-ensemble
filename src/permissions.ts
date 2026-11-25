import type { Database } from "./db"
import { log } from "./log"
import type { DescendantTracker, MemberRegistry } from "./state"
import { findTeamBySession } from "./types"
import type { V2SetupContext } from "./v2-setup"

export interface Rule {
  action: string
  resource: string
  effect: "allow" | "deny" | "ask"
}

interface PermissionEvaluation {
  sessionID: string
  action: string
  resources: string[]
  effect: Rule["effect"]
  message?: string
}

interface PermissionSession {
  parentID?: string
  agent?: string
  permissions?: Rule[]
  location?: { directory: string }
}

export function matches(value: string, pattern: string): boolean {
  const normalized = pattern.replaceAll("\\", "/")
  const trailingArgs = normalized.endsWith(" *")
  const glob = trailingArgs ? normalized.slice(0, -2) : normalized
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*").replaceAll("?", ".")
  return new RegExp(`^${escaped}${trailingArgs ? "(?: .*)?" : ""}$`, "s").test(value.replaceAll("\\", "/"))
}

export function evaluate(rules: Rule[], action: string, resource: string): Rule["effect"] {
  return rules.findLast(rule => matches(action, rule.action) && matches(resource, rule.resource))?.effect ?? "ask"
}

export async function registerPermissionPolicy(
  ctx: V2SetupContext, db: Database, registry: MemberRegistry, tracker?: DescendantTracker,
): Promise<void> {
  const parents = new Map<string, string | null>()
  const hasActiveMembers = db.query(
    "SELECT 1 FROM team t JOIN team_member m ON m.team_id = t.id WHERE t.status = 'active' LIMIT 1",
  )
  await ctx.permission?.hook?.("evaluate", async (raw) => {
    if (!hasActiveMembers.get()) return
    const event = raw as PermissionEvaluation
    let sessionID: string | undefined = event.sessionID
    let teamId: string | undefined
    for (let depth = 0; sessionID && depth <= 3; depth++) {
      const team = findTeamBySession(db, registry, sessionID)
      if (team) {
        if (team.role === "member") teamId = team.teamId
        break
      }
      if (depth === 3) break
      const knownParent: string | null | undefined = tracker?.getParent(sessionID) ?? parents.get(sessionID)
      if (knownParent !== undefined) {
        sessionID = knownParent ?? undefined
      } else {
        const session = await ctx.session.get({ sessionID }).catch(() => undefined) as PermissionSession | undefined
        if (session) parents.set(sessionID, session.parentID ?? null)
        sessionID = session?.parentID
      }
    }
    if (!teamId) return

    const team = db.query("SELECT lead_session_id FROM team WHERE id = ?").get(teamId) as { lead_session_id: string } | null
    const lead = team
      ? await ctx.session.get({ sessionID: team.lead_session_id }).catch(() => undefined) as PermissionSession | undefined
      : undefined
    const agent = lead?.agent
      ? await ctx.agent?.get({ agentID: lead.agent, ...(lead.location ? { location: { directory: lead.location.directory } } : {}) })
        .catch(() => undefined) as { data?: { permissions?: Rule[] }; permissions?: Rule[] } | undefined
      : undefined
    const rules = [...(agent?.data?.permissions ?? agent?.permissions ?? []), ...(lead?.permissions ?? [])]
    const originalEffect = event.effect
    const decisions = event.resources.map(resource => evaluate(rules, event.action, resource))
    if (decisions.includes("deny")) {
      event.effect = "deny"
      event.message = "The lead's permission rules deny this action. Continue without it, or report the blocker to the lead with team_message."
    } else if (event.effect === "ask") {
      if (decisions.length > 0 && decisions.every(effect => effect === "allow")) {
        event.effect = "allow"
      } else {
        event.effect = "deny"
        event.message = "Nobody can approve requests for teammates. This action is not pre-approved for the team. Continue without it, or report the blocker to the lead with team_message."
      }
    }
    if (event.effect !== originalEffect) log(`permission: team=${teamId} session=${event.sessionID} action=${event.action} decision=${event.effect}`)
  })
}

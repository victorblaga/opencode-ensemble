import type { Database } from "./db"
import { log } from "./log"
import type { MemberRegistry } from "./state"
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

export async function registerPermissionPolicy(ctx: V2SetupContext, db: Database, registry: MemberRegistry): Promise<void> {
  await ctx.permission?.hook?.("evaluate", async (raw) => {
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
      const session = await ctx.session.get({ sessionID }).catch(() => undefined) as PermissionSession | undefined
      sessionID = session?.parentID
    }
    if (!teamId) return

    const team = db.query("SELECT lead_session_id FROM team WHERE id = ?").get(teamId) as { lead_session_id: string } | null
    const lead = team
      ? await ctx.session.get({ sessionID: team.lead_session_id }).catch(() => undefined) as PermissionSession | undefined
      : undefined
    const agent = lead?.agent
      ? await ctx.agent?.get({ agentID: lead.agent }).catch(() => undefined) as { permissions?: Rule[] } | undefined
      : undefined
    const rules = [...(agent?.permissions ?? []), ...(lead?.permissions ?? [])]
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
    log(`permission: team=${teamId} session=${event.sessionID} action=${event.action} decision=${event.effect}`)
  })
}

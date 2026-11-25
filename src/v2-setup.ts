import type { Database } from "./db"
import { createDb, getDbPath } from "./db"
import type { MemberRegistry, DescendantTracker } from "./state"
import { MemberRegistry as MemberRegistryImpl, DescendantTracker as DescendantTrackerImpl, PendingPurgeApprovals } from "./state"
import { dispatchV2Event, type V2EventLike } from "./v2-events"
import { deliverPrompt, type V2SessionPort } from "./v2-session"
import type { V2Context } from "./v2-client"
import { createV2Client } from "./v2-client"
import { registerV2Tools } from "./v2-tools"
import { onLeadIdle, wakeLeadIfPending } from "./wake"
import type { PluginClient, ToolDeps } from "./types"
import { ProgressTracker } from "./progress"
import { checkToolIsolation, shouldNudgeIdleMember } from "./hooks"
import { hasReportedCompletion } from "./messaging"
import { enrichToolError } from "./tool-arg-hint"
import { claimTeam, teamOwnership } from "./host"
import { rehydrateRegistry } from "./recovery"
import { findTeamBySession } from "./types"
import { loadConfig } from "./config"
import { TokenBucket } from "./rate-limit"
import { hostedActivityBuffer, recordFromToolBefore, recordFromToolAfter } from "./activity"
import { buildLeadSystemPrompt, buildTeammateSystemPrompt, buildTeamCompactionContext } from "./system-prompt"
import { ensureDashboard, releaseDashboardClient } from "./dashboard"
import { EnsembleRpc, emitMemberEvent, emitNoticeEvent } from "./v2-rpc"
import { waiterRequired } from "./waiter"
import { log } from "./log"

/** V2 setup context subset (structural, mock-friendly). */
export interface V2SetupContext {
  location: { directory: string; project?: { id?: string } }
  agent?: V2Context["agent"]
  options: Record<string, unknown>
  session: V2Context["session"] & {
    hook(name: string, cb: (event: never) => unknown): Promise<{ dispose(): Promise<void> }>
  }
  worktree: V2Context["worktree"]
  permission: V2Context["permission"]
  event: {
    subscribe(opts?: { signal?: AbortSignal }): AsyncIterable<V2EventLike>
  }
  tool: {
    hook(name: string, cb: (event: never) => unknown): Promise<{ dispose(): Promise<void> }>
    transform(cb: (editor: never) => void): Promise<{ dispose(): Promise<void> }>
  }
  rpc: {
    register(
      definition: unknown,
      handlers: Record<string, (input: unknown, context: unknown) => Promise<unknown>>,
    ): Promise<{ events: { emit(name: string, data: unknown): Promise<unknown> } }>
  }
  shell: {
    hook(name: string, cb: (event: never) => unknown): Promise<{ dispose(): Promise<void> }>
  }
}

/** Extract answer text from a V2 tool result for approval matching. */
export function extractQuestionOutput(result?: {
  content?: string | Array<{ type?: string; text?: string }>
}): string {
  const content = result?.content
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    return content
      .filter((part) => part.type === "text")
      .map((part) => part.text ?? "")
      .join("\n")
  }
  return ""
}

/** Options for setupEnsemble. */
export interface SetupOptions {
  /** SQLite path. Defaults to the global ensemble.db. */
  dbPath?: string
  /** Dashboard port. Defaults to config; 0 disables. */
  dashboardPort?: number
}

/** Live handle for a V2 ensemble instance. */
export interface EnsembleHandle {
  db: Database
  registry: MemberRegistry
  tracker: DescendantTracker
  /** Dispatch one event (used by the live subscription loop; tests call directly). */
  dispatch(event: V2EventLike): Promise<void>
  /** Stop the event loop and release resources. */
  dispose(): Promise<void>
}

/**
 * Initialize Ensemble on a V2 plugin context: database, registries, event
 * subscription, tool hooks, session hooks, and shell env. Tool registration
 * lands in the next slice.
 */
export async function setupEnsemble(
  ctx: V2SetupContext,
  options: SetupOptions = {},
): Promise<EnsembleHandle> {
  const db = createDb(options.dbPath ?? getDbPath())
  log(`init:instance directory=${ctx.location.directory}`)
  const config = loadConfig(ctx.location.directory)
  config.dashboardPort = options.dashboardPort ?? config.dashboardPort
  const registry: MemberRegistry = new MemberRegistryImpl()
  const tracker: DescendantTracker = new DescendantTrackerImpl()
  const purgeApprovals = new PendingPurgeApprovals()
  const activityBuffer = hostedActivityBuffer
  const progressTracker = new ProgressTracker()
  const nudgedMembers = new Set<string>()

  // Rehydrate the in-memory registry from SQLite so members from before a
  // restart are visible again. Without this, their events are ignored and
  // teams freeze silently after every server restart (seen live 2026-09-14).
  const rehydrated = rehydrateRegistry(db, registry, process.pid)
  if (rehydrated > 0) log(`init:registry:rehydrated members=${rehydrated}`)

  /** Send the idle-without-report nudge once per member. */
  const nudgeMember = (teamId: string, memberName: string, sessionId: string): void => {
    const nudgeKey = `${teamId}:${memberName}`
    if (nudgedMembers.has(nudgeKey)) return
    if (!shouldNudgeIdleMember(db, teamId, memberName)) return
    if (hasReportedCompletion(db, teamId, memberName)) return
    nudgedMembers.add(nudgeKey)
    db.run("UPDATE team_member SET last_nudged_at = ? WHERE team_id = ? AND name = ?", [
      Date.now(),
      teamId,
      memberName,
    ])
    log(`nudge:idle-without-report name=${memberName}`)
    void deliverPrompt(
      ctx.session as unknown as V2SessionPort,
      sessionId,
      "[System]: You completed your work but did not report results. Send your findings to the lead via team_message now.",
    ).catch((err) => {
      log(`nudge:idle-without-report:failed name=${memberName} err=${err instanceof Error ? err.message : String(err)}`)
    })
  }

  const rateLimiter = new TokenBucket({
    capacity: config.rateLimitCapacity,
    refillRate: 2,
    refillIntervalMs: 1000,
  })
  const controller = new AbortController()

  let wakeClient: PluginClient | undefined

  const dispatch = async (event: V2EventLike): Promise<void> => {
    if (event.type === "session.created") {
      dispatchV2Event(db, registry, tracker, event)
      return
    }
    const sessionID = event.data?.sessionID
    if (!sessionID) return
    const team = findTeamBySession(db, registry, sessionID)
    if (!team || teamOwnership(db, team.teamId) !== "mine") return
    const interrupted = event.type === "session.execution.interrupted"

    if (team.role === "lead") {
      const raw = event.data?.status
      const status = event.type === "session.status"
        ? (typeof raw === "string" ? raw : raw?.type)
        : event.type === "session.idle" || event.type === "session.execution.succeeded"
          || event.type === "session.execution.failed" || interrupted
          ? "idle"
          : event.type === "session.execution.started" ? "busy"
            : event.type === "session.retry.scheduled" ? "retry" : undefined
      if (status === "idle" || status === "busy" || status === "retry") {
        db.run("UPDATE team SET lead_status = ? WHERE id = ?", [status, team.teamId])
      }
      if (status === "idle" && !interrupted && wakeClient) {
        const finishedTurn = event.type === "session.execution.succeeded" || event.type === "session.execution.failed"
        const wake = finishedTurn
          ? onLeadIdle(wakeClient, db, team.teamId, config)
          : wakeLeadIfPending(wakeClient, db, team.teamId)
        wake.catch((err) => {
          log(`wake-lead:failed err=${err instanceof Error ? err.message : String(err)}`)
        })
      }
      return
    }
    const transition = dispatchV2Event(db, registry, tracker, event)
    if (!interrupted && transition?.to === "ready" && transition.from === "busy") {
      nudgeMember(transition.teamId, transition.memberName, sessionID)
    }
    if (transition && rpc) {
      await emitMemberEvent(rpc, transition).catch(() => {
        // Companions are optional — never break the state machine for them.
      })
      if (transition.to === "ready" && transition.from === "busy") {
        await emitNoticeEvent(rpc, {
          title: "Team",
          message: `${transition.memberName} finished`,
          variant: "success",
        }).catch(() => undefined)
      } else if (transition.to === "error") {
        await emitNoticeEvent(rpc, {
          title: "Team",
          message: `${transition.memberName} errored`,
          variant: "error",
        }).catch(() => undefined)
      }
    }
  }

  // RPC bridge for terminal companions (toasts, navigation). Best-effort:
  // a failed registration must not break tools, hooks, or events.
  let rpc: { events: { emit(name: string, data: unknown): Promise<unknown> } } | null = null
  try {
    rpc = await ctx.rpc.register(EnsembleRpc, {
      summary: async (input) => {
        const team = (input as { team?: string }).team ?? ""
        const row = db.query("SELECT status FROM team WHERE name = ?").get(team) as {
          status: string
        } | null
        if (!row) return { text: `No team "${team}".` }
        const members = db.query("SELECT name, status FROM team_member WHERE team_id IN (SELECT id FROM team WHERE name = ?)").all(team) as Array<{
          name: string
          status: string
        }>
        const summary = members.map((m) => `${m.name}: ${m.status}`).join(", ")
        return { text: `Team "${team}" (${row.status}): ${summary || "no members"}` }
      },
      teamContext: async (input) => {
        const sessionID = (input as { sessionID?: string }).sessionID ?? ""
        const teamInfo = findTeamBySession(db, registry, sessionID)
        if (!teamInfo) return { team: null, members: [], tasks: { pending: 0, done: 0 } }
        const members = db.query("SELECT name, status FROM team_member WHERE team_id = ?").all(
          teamInfo.teamId,
        ) as Array<{ name: string; status: string }>
        const pending = (
          db.query("SELECT COUNT(*) as c FROM team_task WHERE team_id = ? AND status != 'completed'").get(
            teamInfo.teamId,
          ) as { c: number }
        ).c
        const done = (
          db.query("SELECT COUNT(*) as c FROM team_task WHERE team_id = ? AND status = 'completed'").get(
            teamInfo.teamId,
          ) as { c: number }
        ).c
        return { team: teamInfo.teamName, members, tasks: { pending, done } }
      },
    })
  } catch (err) {
    log(`init:rpc:failed err=${err instanceof Error ? err.message : String(err)}`)
  }

  // Live event loop — fire-and-forget; dispose() aborts it.
  void (async () => {
    try {
      for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
        await dispatch(event)
      }
    } catch {
      // Aborted on dispose or stream error — nothing to report.
    }
  })()

  await ctx.tool.hook("execute.before", (raw) => {
    const input = raw as unknown as { tool: string; sessionID: string }
    checkToolIsolation(registry, tracker, input.tool, input.sessionID, db)
    if (input.tool.startsWith("team_")) {
      if (!rateLimiter.tryConsume()) {
        return rateLimiter.waitForToken().then(() => undefined)
      }
    }
    recordFromToolBefore({ sessionID: input.sessionID, tool: input.tool }, registry, activityBuffer)
  })

  await ctx.tool.hook("execute.after", (raw) => {
    const event = raw as unknown as {
      tool: string
      sessionID: string
      input: unknown
      status: string
      result?: { content?: string | Array<{ type?: string; text?: string }> }
      error?: { message?: unknown }
    }
    if (event.status === "error" && event.error) {
      // Weak-model arg fumbles (issue #39): the call is already dead from
      // validation, so append an explicit "the param is X, not Y" hint to
      // the error the model sees. Arguments are never rewritten — the
      // model stays in the correction loop. Fail-open by design: a
      // non-fumble error is returned untouched.
      if (enrichToolError(event.tool, event.error, event.input)) {
        log(`tool-arg-hint:fired tool=${event.tool} session=${event.sessionID}`)
      }
    }
    if (event.tool === "question") {
      // Feed the answer text to purge approvals (team_cleanup confirm flow).
      // The question tool renders in every client, so this is the universal
      // approval channel on V2 — no forms or TUI needed.
      purgeApprovals.recordQuestionAnswer(
        event.sessionID,
        extractQuestionOutput(event.result),
        event.input,
      )
    }
    recordFromToolAfter(
      { sessionID: event.sessionID, tool: event.tool },
      {},
      registry,
      activityBuffer,
    )
  })

  await ctx.session.hook("context", (raw) => {
    const event = raw as unknown as {
      sessionID: string
      system: Array<{ type: string; text: string }>
    }
    if (!event.sessionID) return
    const teamInfo = findTeamBySession(db, registry, event.sessionID)
    if (!teamInfo) return
    if (teamInfo.role === "lead" && teamOwnership(db, teamInfo.teamId) === "orphaned") {
      if (claimTeam(db, teamInfo.teamId).claimed && wakeClient) {
        ensureDashboard(db, config, { activityBuffer, client: wakeClient })
      }
      rehydrateRegistry(db, registry, process.pid)
    }
    if (teamOwnership(db, teamInfo.teamId) !== "mine") return
    const prompt =
      teamInfo.role === "lead"
        ? buildLeadSystemPrompt(db, teamInfo.teamId, config, true)
        : buildTeammateSystemPrompt(db, teamInfo.teamId, teamInfo.memberName ?? "unknown", config)
    log(`system-prompt:injected role=${teamInfo.role} len=${prompt.length}`)
    event.system.push({ type: "text", text: prompt })
    if (teamInfo.role === "member") {
      // V2 invokes plugin tools through Code Mode, not direct calls —
      // without this hint teammates attempt direct calls that the runtime
      // rejects with "No tool named team_message is currently available"
      // (seen live 2026-09-14: explore scout denied twice, gave up).
      event.system.push({
        type: "text",
        text: 'Ensemble tools on this platform are called through the execute tool, e.g. tools.team_message({ to: "lead", text: "..." }). Do not call them directly.',
      })
    }
  })

  await ctx.session.hook("compaction", (raw) => {
    const event = raw as unknown as {
      sessionID: string
      system: Array<{ type: string; text: string }>
    }
    if (!event.sessionID) return
    const teamInfo = findTeamBySession(db, registry, event.sessionID)
    if (!teamInfo || teamOwnership(db, teamInfo.teamId) !== "mine") return
    const context = buildTeamCompactionContext(db, teamInfo.teamId, teamInfo.role, teamInfo.memberName)
    event.system.push({ type: "text", text: context })
  })

  // OQ-V2-shell: the V2 shell hook carries no sessionID, so per-session
  // ENSEMBLE_* env cannot be scoped. Registered as a placeholder until the
  // API gains session scope — team tools and prompts carry identity instead.
  await ctx.shell.hook("create.before", () => undefined)

  const client = createV2Client(ctx, { rpcEmitter: rpc ?? undefined, leadWaiter: waiterRequired(config) })
  wakeClient = client
  const deps: ToolDeps = {
    v2: true,
    onTeamHosted: () => ensureDashboard(db, config, { activityBuffer, client }),
    db,
    registry,
    tracker,
    purgeApprovals,
    client,
    directory: ctx.location.directory,
    config,
    progressTracker,
  }
  await registerV2Tools(ctx.tool, deps)

  ensureDashboard(db, config, { activityBuffer, client })

  return {
    db,
    registry,
    tracker,
    dispatch,
    dispose: async () => {
      controller.abort()
      releaseDashboardClient(client)
    },
  }
}

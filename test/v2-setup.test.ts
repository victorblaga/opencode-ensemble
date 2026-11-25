import { describe, expect, test } from "bun:test"
import { setupEnsemble, extractQuestionOutput, type V2SetupContext } from "../src/v2-setup"
/** Mock V2 setup context: hook registry + programmable event intake. */
function mockSetupCtx() {
  const hooks: Record<string, Array<(event: never) => unknown>> = {}
  const hook = (domain: string) => async (_name: string, cb: (event: never) => unknown) => {
    ;(hooks[domain] ??= []).push(cb)
    return { dispose: async () => undefined }
  }
  const ctx = {
    location: { directory: "/tmp/v2-setup-test" },
    options: {},
    session: {
      create: async () => ({ id: "ses_new" }),
      prompt: async () => ({ id: "msg_1" }),
      synthetic: async () => ({ id: "syn_1" }),
      switchAgent: async () => undefined,
      switchModel: async () => undefined,
      interrupt: async () => undefined,
      get: async () => ({ id: "ses_x" }),
      context: async () => [],
      wait: async () => undefined,
      hook: hook("session"),
    },
    permission: {
      rules: async () => undefined,
    },
    worktree: {
      create: async () => ({ directory: "/wt/x" }),
      remove: async () => undefined,
      list: async () => [],
      refresh: async () => undefined,
    },
    event: {
      subscribe: (_opts?: unknown) => {
        void _opts
        async function* stream(): AsyncGenerator<never> {
          // Tests drive events via handle.dispatch; the live loop drains this.
        }
        return stream()
      },
    },
    tool: {
      hook: hook("tool"),
      transform: async (_cb: (editor: never) => void) => ({ dispose: async () => undefined }),
    },
    shell: { hook: hook("shell") },
  }
  return { ctx: ctx as unknown as V2SetupContext, hooks }
}

function seedLeadAndMember(handle: Awaited<ReturnType<typeof setupEnsemble>>) {  const now = Date.now()
  handle.db.run(
    "INSERT INTO team (id, name, lead_session_id, status, delegate, time_created, time_updated, host_pid) VALUES (?, ?, ?, 'active', 0, ?, ?, ?)",
    ["team1", "alpha", "ses_lead", now, now, process.pid],
  )
  handle.db.run(
    "INSERT INTO team_member (team_id, name, session_id, agent, status, execution_status, time_created, time_updated) VALUES (?, ?, ?, 'build', 'busy', 'running', ?, ?)",
    ["team1", "alice", "ses_alice", now, now],
  )
  handle.registry.register("team1", "alice", "ses_alice")
}

describe("v2-setup (issue #36)", () => {
  test("dispatched status events flow to member state", async () => {
    const { ctx } = mockSetupCtx()
    const handle = await setupEnsemble(ctx, { dbPath: ":memory:", dashboardPort: 0 })
    seedLeadAndMember(handle)
    await handle.dispatch({ type: "session.status", data: { sessionID: "ses_alice", status: "idle" } })
    const row = handle.db.query("SELECT status FROM team_member WHERE name = 'alice'").get() as {
      status: string
    }
    expect(row.status).toBe("ready")
    await handle.dispose()
  })

  test("lead idle event wakes for unseen messages (V2 backstop)", async () => {
    const { ctx } = mockSetupCtx()
    const handle = await setupEnsemble(ctx, { dbPath: ":memory:", dashboardPort: 0 })
    seedLeadAndMember(handle)
    handle.db.run(
      "INSERT INTO team_message (id, team_id, from_name, to_name, content, delivered, read, time_created) VALUES ('m1', 'team1', 'alice', 'lead', 'done', 0, 0, ?)",
      [Date.now()],
    )

    await handle.dispatch({ type: "session.status", data: { sessionID: "ses_lead", status: "idle" } })
    await new Promise(resolve => setTimeout(resolve, 20))

    const team = handle.db.query("SELECT last_wake_at FROM team WHERE id = 'team1'").get() as { last_wake_at: number }
    expect(team.last_wake_at).toBeGreaterThan(0)
    await handle.dispose()
  })

  test("persists lead busy/idle and wakes only on the idle transition", async () => {
    const { ctx } = mockSetupCtx()
    const handle = await setupEnsemble(ctx, { dbPath: ":memory:", dashboardPort: 0 })
    seedLeadAndMember(handle)
    handle.db.run(
      "INSERT INTO team_message (id, team_id, from_name, to_name, content, delivered, read, time_created) VALUES ('m1', 'team1', 'alice', 'lead', 'done', 0, 0, ?)",
      [Date.now()],
    )

    await handle.dispatch({ type: "session.status", data: { sessionID: "ses_lead", status: "busy" } })
    await new Promise(resolve => setTimeout(resolve, 20))
    let team = handle.db.query("SELECT lead_status, last_wake_at FROM team WHERE id = 'team1'").get() as { lead_status: string; last_wake_at: number }
    expect(team.lead_status).toBe("busy")
    expect(team.last_wake_at).toBe(0)

    await handle.dispatch({ type: "session.status", data: { sessionID: "ses_lead", status: "idle" } })
    await new Promise(resolve => setTimeout(resolve, 20))
    team = handle.db.query("SELECT lead_status, last_wake_at FROM team WHERE id = 'team1'").get() as { lead_status: string; last_wake_at: number }
    expect(team.lead_status).toBe("idle")
    expect(team.last_wake_at).toBeGreaterThan(0)
    await handle.dispose()
  })

  test("lead idle event does not wake when the inbox is drained (V2 backstop)", async () => {
    const { ctx } = mockSetupCtx()
    const handle = await setupEnsemble(ctx, { dbPath: ":memory:", dashboardPort: 0 })
    seedLeadAndMember(handle)
    handle.db.run(
      "INSERT INTO team_message (id, team_id, from_name, to_name, content, delivered, read, time_created) VALUES ('m1', 'team1', 'alice', 'lead', 'done', 0, 1, ?)",
      [Date.now()],
    )

    await handle.dispatch({ type: "session.status", data: { sessionID: "ses_lead", status: "idle" } })
    await new Promise(resolve => setTimeout(resolve, 20))

    const team = handle.db.query("SELECT last_wake_at FROM team WHERE id = 'team1'").get() as { last_wake_at: number }
    expect(team.last_wake_at).toBe(0)
    await handle.dispose()
  })

  test("tool execute.before blocks team tools for sub-agents", async () => {
    const { ctx, hooks } = mockSetupCtx()
    const handle = await setupEnsemble(ctx, { dbPath: ":memory:", dashboardPort: 0 })
    seedLeadAndMember(handle)
    handle.tracker.track("ses_child", "ses_alice")
    const before = hooks["tool"]?.[0]
    expect(before).toBeDefined()
    let blocked: unknown = null
    try {
      await before?.({
        tool: "team_message",
        sessionID: "ses_child",
        input: { to: "lead", text: "hi" },
      } as never)
    } catch (err) {
      blocked = err
    }
    expect(String(blocked)).toContain("sub-agents")
    await handle.dispose()
  })

  test("tool execute.after enriches shell arg-fumble errors (issue #39)", async () => {
    const { ctx, hooks } = mockSetupCtx()
    const handle = await setupEnsemble(ctx, { dbPath: ":memory:", dashboardPort: 0 })
    seedLeadAndMember(handle)
    const after = hooks["tool"]?.[1]
    expect(after).toBeDefined()
    const original = 'Invalid arguments for tool "shell":\n- command: Missing key'
    const event = {
      tool: "shell",
      sessionID: "ses_alice",
      input: { cmd: "git remote -v 2>&1", description: "Check happy remotes again" },
      status: "error",
      error: { message: original },
    }
    await after?.(event as never)
    const message = (event.error as { message: string }).message
    expect(message).toContain(original)
    expect(message).toContain('"cmd"')
    expect(message).toContain('"command"')
    await handle.dispose()
  })

  test("tool execute.after leaves non-fumble errors untouched (issue #39)", async () => {
    const { ctx, hooks } = mockSetupCtx()
    const handle = await setupEnsemble(ctx, { dbPath: ":memory:", dashboardPort: 0 })
    seedLeadAndMember(handle)
    const after = hooks["tool"]?.[1]
    const original = "Command timed out after 120000ms"
    const event = {
      tool: "shell",
      sessionID: "ses_alice",
      input: { command: "sleep 999" },
      status: "error",
      error: { message: original },
    }
    await after?.(event as never)
    expect((event.error as { message: string }).message).toBe(original)
    await handle.dispose()
  })

  test("shell hook is registered (per-session env unavailable on V2 — see OQ-V2-shell)", async () => {
    const { ctx, hooks } = mockSetupCtx()
    const handle = await setupEnsemble(ctx, { dbPath: ":memory:", dashboardPort: 0 })
    seedLeadAndMember(handle)
    const shellHook = hooks["shell"]?.[0]
    expect(shellHook).toBeDefined()
    const event = { sessionID: "ses_lead", env: {} as Record<string, string | undefined> }
    await shellHook?.(event as never)
    expect(event.env["ENSEMBLE_TEAM"]).toBeUndefined()
    await handle.dispose()
  })

  test("session context hook appends team system prompt for team sessions", async () => {
    const { ctx, hooks } = mockSetupCtx()
    const handle = await setupEnsemble(ctx, { dbPath: ":memory:", dashboardPort: 0 })
    seedLeadAndMember(handle)
    const sessionHooks = hooks["session"] ?? []
    expect(sessionHooks.length).toBeGreaterThan(0)
    const contextHook = sessionHooks[0]
    const event = { sessionID: "ses_lead", system: [] as Array<{ type: string; text: string }> }
    await contextHook?.(event as never)
    expect(event.system.length).toBe(1)
    expect(event.system[0]?.text).toContain("alpha")
    // Member sessions get the Code Mode invocation hint; leads do not.
    const memberEvent = { sessionID: "ses_alice", system: [] as Array<{ type: string; text: string }> }
    await contextHook?.(memberEvent as never)
    expect(memberEvent.system.length).toBe(2)
    expect(memberEvent.system[1]?.text).toContain("execute")
    await handle.dispose()
  })


  test("extractQuestionOutput reads string and part-array results", () => {
    expect(extractQuestionOutput({ content: "Approve purge abc123" })).toBe("Approve purge abc123")
    expect(
      extractQuestionOutput({ content: [{ type: "text", text: "yes" }, { type: "other" }] }),
    ).toBe("yes")
    expect(extractQuestionOutput(undefined)).toBe("")
  })

  test("foreign teams are untouched at startup and on status events, but ancestry is tracked", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs")
    const { tmpdir } = await import("node:os")
    const { join } = await import("node:path")
    const dir = mkdtempSync(join(tmpdir(), "ensemble-foreign-"))
    const dbPath = join(dir, "test.db")
    try {
      const { ctx } = mockSetupCtx()
      const seed = await setupEnsemble(ctx, { dbPath, dashboardPort: 0 })
      seedLeadAndMember(seed)
      seed.db.run("UPDATE team SET host_pid = ?, lead_status = 'busy'", [process.ppid])
      await seed.dispose()
      seed.db.close()

      const { ctx: foreign } = mockSetupCtx()
      const deliveries: unknown[] = []
      foreign.session.prompt = async (input) => { deliveries.push(input); return { id: "msg" } }
      foreign.session.synthetic = async (input) => { deliveries.push(input); return { id: "msg" } }
      const handle = await setupEnsemble(foreign, { dbPath, dashboardPort: 0 })
      expect(handle.registry.getBySession("ses_alice")).toBeUndefined()
      await handle.dispatch({ type: "session.created", data: { sessionID: "child", parentID: "ses_alice" } })
      await handle.dispatch({ type: "session.execution.succeeded", data: { sessionID: "ses_alice" } })
      await handle.dispatch({ type: "session.execution.interrupted", data: { sessionID: "ses_lead" } })
      expect(handle.tracker.getParent("child")).toBe("ses_alice")
      expect(handle.db.query("SELECT host_pid, lead_status FROM team").get()).toEqual({ host_pid: process.ppid, lead_status: "busy" })
      expect(handle.db.query("SELECT status FROM team_member").get()).toEqual({ status: "busy" })
      expect(deliveries).toEqual([])
      await handle.dispose()
      handle.db.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("interruption returns both a hosted member and the lead to idle", async () => {
    const { ctx } = mockSetupCtx()
    const handle = await setupEnsemble(ctx, { dbPath: ":memory:", dashboardPort: 0 })
    seedLeadAndMember(handle)
    handle.db.run("UPDATE team SET lead_status = 'busy'")
    await handle.dispatch({ type: "session.execution.interrupted", data: { sessionID: "ses_alice" } })
    await handle.dispatch({ type: "session.execution.interrupted", data: { sessionID: "ses_lead" } })
    expect(handle.db.query("SELECT status FROM team_member").get()).toEqual({ status: "ready" })
    expect(handle.db.query("SELECT lead_status FROM team").get()).toEqual({ lead_status: "idle" })
    await handle.dispose()
  })
})

test("a lead interrupt cancels a queued wake for messages still unseen", async () => {
  const { createV2Client } = await import("../src/v2-client")
  const { sendMessage } = await import("../src/messaging")
  const { wakeLeadIfPending } = await import("../src/wake")
  const { ctx } = mockSetupCtx()
  const wakes: unknown[] = []
  ctx.session.synthetic = async input => { wakes.push(input) }
  const handle = await setupEnsemble(ctx, { dbPath: ":memory:", dashboardPort: 0 })
  try {
    seedLeadAndMember(handle)
    sendMessage(handle.db, { teamId: "team1", from: "alice", to: "lead", content: "results" })
    handle.db.run("UPDATE team SET last_wake_at = ?", [Date.now()])
    const client = createV2Client(ctx)
    expect(await wakeLeadIfPending(client, handle.db, "team1", { cooldownMs: 40 })).toBe(false)
    await handle.dispatch({ type: "session.execution.interrupted", data: { sessionID: "ses_lead" } })
    await Bun.sleep(65)
    expect(wakes).toHaveLength(0)
    expect(await wakeLeadIfPending(client, handle.db, "team1", { cooldownMs: 0 })).toBe(true)
    expect(wakes).toHaveLength(1)
  } finally {
    await handle.dispose()
    handle.db.close()
  }
})

test("only lead context adopts the orphan and presents its interrupted worker notice", async () => {
  const { ctx, hooks } = mockSetupCtx()
  const handle = await setupEnsemble(ctx, { dbPath: ":memory:", dashboardPort: 0 })
  try {
    seedLeadAndMember(handle)
    handle.db.run("UPDATE team SET host_pid = NULL")
    handle.registry.unregisterTeam("team1")
    const context = hooks.session?.[0]
    expect(context).toBeDefined()
    const worker = { sessionID: "ses_alice", system: [] as Array<{ text: string }> }
    await context?.(worker as never)
    expect(worker.system).toEqual([])
    expect(handle.db.query("SELECT host_pid FROM team").get()).toEqual({ host_pid: null })
    const lead = { sessionID: "ses_lead", system: [] as Array<{ text: string }> }
    await context?.(lead as never)
    expect(lead.system[0]?.text).toContain("Interrupted teammates: alice")
    expect(handle.db.query("SELECT host_pid, lead_status FROM team").get()).toEqual({ host_pid: process.pid, lead_status: "busy" })
    expect(handle.db.query("SELECT status, execution_status FROM team_member").get()).toEqual({ status: "ready", execution_status: "cancelled" })
  } finally {
    await handle.dispose()
    handle.db.close()
  }
})

test("unrelated session deltas do not look up team membership", async () => {
  const { ctx } = mockSetupCtx()
  const handle = await setupEnsemble(ctx, { dbPath: ":memory:", dashboardPort: 0 })
  const query = handle.db.query.bind(handle.db)
  let queries = 0
  handle.db.query = (sql) => { queries++; return query(sql) }
  try {
    await handle.dispatch({ type: "session.text.delta", data: { sessionID: "unrelated" } })
    expect(queries).toBe(0)
    await handle.dispatch({ type: "session.created", data: { sessionID: "child", parentID: "parent" } })
    expect(handle.tracker.getParent("child")).toBe("parent")
  } finally {
    await handle.dispose()
    handle.db.close()
  }
})

test.each(["team_create", "existing team at setup"])("the V2 dashboard starts from %s", async (entrypoint) => {
  // Use a separate host process for each case: the dashboard binds once per process.
  const script = `
    import { mkdtempSync, rmSync } from "node:fs"
    import { createServer } from "node:net"
    import { tmpdir } from "node:os"
    import { join } from "node:path"
    import { createDb } from "./src/db"
    import { setupEnsemble } from "./src/v2-setup"
    import { insertTeam } from "./test/helpers"

    const entrypoint = process.argv.at(-1)
    const dir = mkdtempSync(join(tmpdir(), "ensemble-dashboard-entrypoint-"))
    const dbPath = join(dir, "test.db")
    const probe = createServer()
    await new Promise(resolve => probe.listen(0, "127.0.0.1", resolve))
    const port = probe.address().port
    await new Promise(resolve => probe.close(resolve))
    const defs = new Map()
    const hook = async () => ({ dispose: async () => {} })
    const ctx = {
      location: { directory: dir },
      options: {},
      session: { hook, wait: async () => {}, interrupt: async () => ({ interrupted: false }) },
      permission: { hook },
      shell: { hook },
      tool: {
        hook,
        transform: async (register) => register({
          add: (def) => defs.set(def.name, def),
        }),
      },
      rpc: { register: async () => ({}) },
      event: { subscribe: async function* () {} },
    }
    if (entrypoint === "existing team at setup") {
      const db = createDb(dbPath)
      insertTeam(db, "existing", "alpha", "lead")
      db.close()
    }
    const handle = await setupEnsemble(ctx, { dbPath, dashboardPort: port })
    try {
      if (entrypoint === "team_create") {
        await defs.get("team_create").execute({ name: "alpha" }, { sessionID: "lead" })
      }
      for (let attempt = 0; attempt < 40; attempt++) {
        const result = await fetch("http://127.0.0.1:" + port + "/api/state").catch(() => undefined)
        if (result?.ok) {
          if ((await result.json()).teams[0]?.name !== "alpha") throw new Error("Wrong team")
          break
        }
        if (attempt === 39) throw new Error("Dashboard did not start for " + entrypoint)
        await Bun.sleep(10)
      }
    } finally {
      await handle.dispose()
      handle.db.close()
      rmSync(dir, { recursive: true, force: true })
    }
  `
  const proc = Bun.spawn([process.execPath, "-e", script, "--", entrypoint], { stderr: "pipe", stdout: "pipe" })
  const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()])
  expect({ code, stderr }).toEqual({ code: 0, stderr: "" })
})

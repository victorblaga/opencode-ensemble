import { describe, test, expect, beforeEach } from "bun:test"
import { Database as BunDatabase } from "bun:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { setupDeps, insertTeam, insertMember } from "./helpers"
import { sendMessage, markDelivered } from "../src/messaging"
import { applyMigrations } from "../src/schema"
import { buildLeadSystemPrompt } from "../src/system-prompt"
import { executeTeamMessage } from "../src/tools/team-message"
import { executeTeamResults } from "../src/tools/team-results"
import { wakeLeadIfPending, resetWakeState } from "../src/wake"

type Deps = ReturnType<typeof setupDeps>

/** Flush the fire-and-forget wake helper's microtasks. */
async function flush(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

function wakes(deps: Deps): Array<{ sessionID: string; parts: Array<{ text: string }>; synthetic?: boolean }> {
  return deps.client.calls
    .filter(c => c.method === "session.promptAsync")
    .map(c => c.args[0] as { sessionID: string; parts: Array<{ text: string }>; synthetic?: boolean })
}

describe("wakeLeadIfPending (issues #48, #57)", () => {
  let deps: Deps

  beforeEach(() => {
    deps = setupDeps()
    insertTeam(deps.db, "t1", "my-team", "lead-sess")
    insertMember(deps.db, "t1", "alice", "sess-alice")
    deps.registry.register("t1", "alice", "sess-alice")
  })

  test("wakes an idle lead when there are unseen messages", async () => {
    sendMessage(deps.db, { teamId: "t1", from: "alice", to: "lead", content: "done" })

    const sent = await wakeLeadIfPending(deps.client, deps.db, "t1")
    expect(sent).toBe(true)

    const calls = wakes(deps)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.sessionID).toBe("lead-sess")
    expect(calls[0]!.synthetic).toBe(true)
    expect(calls[0]!.parts[0]!.text).toContain("1 new team message")
    expect(calls[0]!.parts[0]!.text).toContain("team_results")
  })

  test("does not wake when the team no longer exists (purge race, #48)", async () => {
    sendMessage(deps.db, { teamId: "t1", from: "alice", to: "lead", content: "done" })
    deps.db.run("DELETE FROM team WHERE id = 't1'")

    const sent = await wakeLeadIfPending(deps.client, deps.db, "t1")
    expect(sent).toBe(false)
    expect(wakes(deps)).toHaveLength(0)
  })

  test("does not wake when the team is archived (cleanup race, #48)", async () => {
    sendMessage(deps.db, { teamId: "t1", from: "alice", to: "lead", content: "done" })
    deps.db.run("UPDATE team SET status = 'archived' WHERE id = 't1'")

    const sent = await wakeLeadIfPending(deps.client, deps.db, "t1")
    expect(sent).toBe(false)
    expect(wakes(deps)).toHaveLength(0)
  })

  test("does not wake when all messages were already auto-delivered", async () => {
    const id = sendMessage(deps.db, { teamId: "t1", from: "alice", to: "lead", content: "done" })
    markDelivered(deps.db, id)

    const sent = await wakeLeadIfPending(deps.client, deps.db, "t1")
    expect(sent).toBe(false)
    expect(wakes(deps)).toHaveLength(0)
  })

  test("does not wake when the inbox was drained via team_results", async () => {
    sendMessage(deps.db, { teamId: "t1", from: "alice", to: "lead", content: "done" })
    await executeTeamResults(deps, {}, "lead-sess")
    resetWakeState(deps.db)

    const sent = await wakeLeadIfPending(deps.client, deps.db, "t1")
    expect(sent).toBe(false)
    expect(wakes(deps)).toHaveLength(0)
  })

  test("wakes for a final report even when every teammate is done", async () => {
    // The old allDone gate could strand the last completion report if the
    // immediate wake was skipped while the lead was busy.
    deps.db.run("UPDATE team_member SET status = 'ready' WHERE team_id = 't1'")
    sendMessage(deps.db, { teamId: "t1", from: "alice", to: "lead", content: "final report" })

    const sent = await wakeLeadIfPending(deps.client, deps.db, "t1")
    expect(sent).toBe(true)
    expect(wakes(deps)).toHaveLength(1)
  })

  test("does not queue a wake behind a busy lead", async () => {
    sendMessage(deps.db, { teamId: "t1", from: "alice", to: "lead", content: "done" })
    deps.db.run("UPDATE team SET lead_status = 'busy' WHERE id = 't1'")

    const sent = await wakeLeadIfPending(deps.client, deps.db, "t1")
    expect(sent).toBe(false)
    expect(wakes(deps)).toHaveLength(0)
  })

  test("does not queue a wake behind a busy lead on V2 (idle backstop retries)", async () => {
    sendMessage(deps.db, { teamId: "t1", from: "alice", to: "lead", content: "done" })
    deps.client.agent = { readOnly: async () => undefined }
    deps.db.run("UPDATE team SET lead_status = 'busy' WHERE id = 't1'")

    const sent = await wakeLeadIfPending(deps.client, deps.db, "t1")
    expect(sent).toBe(false)
    expect(wakes(deps)).toHaveLength(0)
  })

  test("force sends even when the lead is busy (system/error notifications)", async () => {
    sendMessage(deps.db, { teamId: "t1", from: "system", to: "lead", content: "alice failed" })
    deps.db.run("UPDATE team SET lead_status = 'busy' WHERE id = 't1'")

    const sent = await wakeLeadIfPending(deps.client, deps.db, "t1", { force: true })
    expect(sent).toBe(true)
    expect(wakes(deps)).toHaveLength(1)
  })

  test("coalesces concurrent wakes into one", async () => {
    sendMessage(deps.db, { teamId: "t1", from: "alice", to: "lead", content: "one" })
    sendMessage(deps.db, { teamId: "t1", from: "alice", to: "lead", content: "two" })

    await Promise.all([
      wakeLeadIfPending(deps.client, deps.db, "t1"),
      wakeLeadIfPending(deps.client, deps.db, "t1"),
    ])
    expect(wakes(deps)).toHaveLength(1)
  })

  test("schedules a trailing retry after a cooldown skip", async () => {
    sendMessage(deps.db, { teamId: "t1", from: "alice", to: "lead", content: "first" })
    expect(await wakeLeadIfPending(deps.client, deps.db, "t1", { cooldownMs: 10 })).toBe(true)

    sendMessage(deps.db, { teamId: "t1", from: "alice", to: "lead", content: "second" })
    expect(await wakeLeadIfPending(deps.client, deps.db, "t1", { cooldownMs: 10 })).toBe(false)

    await new Promise(resolve => setTimeout(resolve, 30))
    expect(wakes(deps)).toHaveLength(2)
  })

  test("force bypasses the cooldown for system/error notifications", async () => {
    sendMessage(deps.db, { teamId: "t1", from: "alice", to: "lead", content: "first" })
    expect(await wakeLeadIfPending(deps.client, deps.db, "t1")).toBe(true)

    sendMessage(deps.db, { teamId: "t1", from: "system", to: "lead", content: "error" })
    expect(await wakeLeadIfPending(deps.client, deps.db, "t1", { force: true })).toBe(true)
    expect(wakes(deps)).toHaveLength(2)
  })

  test("cooldown is persisted across plugin instances sharing a DB file", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "ensemble-wake-"))
    const file = path.join(dir, "ensemble.db")
    const db1 = new BunDatabase(file)
    const db2 = new BunDatabase(file)
    for (const db of [db1, db2]) {
      db.exec("PRAGMA journal_mode=WAL")
      db.exec("PRAGMA foreign_keys=ON")
      applyMigrations(db)
    }
    try {
      insertTeam(db1, "t1", "my-team", "lead-sess")
      sendMessage(db1, { teamId: "t1", from: "alice", to: "lead", content: "first" })
      expect(await wakeLeadIfPending(deps.client, db1, "t1")).toBe(true)

      // A second connection represents another plugin instance (e.g. a
      // teammate worktree). The cooldown lives in the DB, so it still applies.
      sendMessage(db2, { teamId: "t1", from: "alice", to: "lead", content: "second" })
      expect(await wakeLeadIfPending(deps.client, db2, "t1")).toBe(false)
      expect(wakes(deps)).toHaveLength(1)
    } finally {
      db1.close()
      db2.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("re-checks team state after the status lookup (cleanup between schedule and send)", async () => {
    sendMessage(deps.db, { teamId: "t1", from: "alice", to: "lead", content: "done" })

    let releaseMessages: (() => void) | undefined
    deps.client.session.messages = () => new Promise((resolve) => {
      releaseMessages = () => resolve({ data: [] })
    })

    const pending = wakeLeadIfPending(deps.client, deps.db, "t1")
    deps.db.run("UPDATE team SET status = 'archived' WHERE id = 't1'")
    releaseMessages!()

    expect(await pending).toBe(false)
    expect(wakes(deps)).toHaveLength(0)
  })

  test("never throws when the selection lookup fails", async () => {
    sendMessage(deps.db, { teamId: "t1", from: "alice", to: "lead", content: "done" })
    deps.client.session.messages = async () => { throw new Error("selection lookup down") }

    await expect(wakeLeadIfPending(deps.client, deps.db, "t1")).resolves.toBe(true)
    expect(wakes(deps)).toHaveLength(1)
  })

  test("preserves the lead's current agent and model on V1 wakes (#37)", async () => {
    sendMessage(deps.db, { teamId: "t1", from: "alice", to: "lead", content: "done" })
    deps.client.session.messages = async () => ({
      data: [{
        info: { role: "user", agent: "plan", model: { providerID: "anthropic", modelID: "claude-sonnet" } },
        parts: [{ type: "text", text: "stay in plan mode" }],
      }],
    })

    await wakeLeadIfPending(deps.client, deps.db, "t1")

    const call = wakes(deps)[0] as { agent?: string; model?: unknown }
    expect(call.agent).toBe("plan")
    expect(call.model).toEqual({ providerID: "anthropic", modelID: "claude-sonnet" })
  })
})

describe("team_message wake coalescing (issue #57)", () => {
  let deps: Deps

  beforeEach(() => {
    deps = setupDeps()
    insertTeam(deps.db, "t1", "my-team", "lead-sess")
    insertMember(deps.db, "t1", "alice", "sess-alice", "busy", "running")
    deps.registry.register("t1", "alice", "sess-alice")
  })

  test("two messages sent back-to-back produce at most one wake", async () => {
    await executeTeamMessage(deps, { to: "lead", text: "first" }, "sess-alice")
    await executeTeamMessage(deps, { to: "lead", text: "second" }, "sess-alice")
    await flush()

    expect(wakes(deps)).toHaveLength(1)
  })

  test("busy lead + drained inbox + shutdown ack produces no post-cleanup wake", async () => {
    // Reproduces the live 0.21.x race end to end.
    deps.db.run("UPDATE team SET lead_status = 'busy' WHERE id = 't1'")
    await executeTeamMessage(deps, { to: "lead", text: "task result" }, "sess-alice")
    await flush()
    expect(wakes(deps)).toHaveLength(0)

    // Lead reads the result during its current turn.
    await executeTeamResults(deps, {}, "lead-sess")

    // Teammate reports completion, then acknowledges shutdown.
    deps.db.run("UPDATE team_member SET reported_to_lead = 1, status = 'shutdown_requested' WHERE team_id = 't1' AND name = 'alice'")
    await executeTeamMessage(deps, { to: "lead", text: "ack" }, "sess-alice")
    await flush()
    expect(wakes(deps)).toHaveLength(0)

    // The system prompt surfaces the ack on the lead's next step (marks it
    // delivered, as in the live run), then the lead goes idle.
    buildLeadSystemPrompt(deps.db, "t1")
    deps.db.run("UPDATE team SET lead_status = 'idle' WHERE id = 't1'")
    expect(await wakeLeadIfPending(deps.client, deps.db, "t1")).toBe(false)

    // Cleanup archives the team; still no wake.
    deps.db.run("UPDATE team SET status = 'archived' WHERE id = 't1'")
    expect(await wakeLeadIfPending(deps.client, deps.db, "t1")).toBe(false)
    expect(wakes(deps)).toHaveLength(0)
  })

  test("does not produce a second wake after the inbox is drained", async () => {
    await executeTeamMessage(deps, { to: "lead", text: "first" }, "sess-alice")
    await executeTeamMessage(deps, { to: "lead", text: "second" }, "sess-alice")
    await executeTeamResults(deps, {}, "lead-sess")
    await flush()

    // The first wake may already have fired before the drain; it must not be
    // followed by a second empty wake.
    expect(wakes(deps).length).toBeLessThanOrEqual(1)
  })
})

test("V2 waiter suppresses wake and re-arms one turn-end reminder", async () => {
  const { mkdirSync, writeFileSync } = await import("node:fs")
  const { onLeadIdle } = await import("../src/wake")
  const deps = setupDeps()
  const team = "wait-reminder"
  const config = { ...deps.config, leadWaiter: "always" as const }
  Object.assign(deps.client, { leadWaiter: true })
  insertTeam(deps.db, team, "waiting", "lead")
  insertMember(deps.db, team, "worker", "worker", "shutdown_requested")
  deps.registry.register(team, "worker", "worker")
  await onLeadIdle(deps.client, deps.db, team, { ...config, leadWaiter: "off" })
  expect(wakes(deps)).toHaveLength(0)
  await onLeadIdle(deps.client, deps.db, team, config)
  await onLeadIdle(deps.client, deps.db, team, config)
  expect(wakes(deps)).toHaveLength(1)
  expect(wakes(deps)[0]?.parts[0]?.text).toContain("1 teammate")
  const state = mkdtempSync(path.join(os.tmpdir(), "ensemble-wake-"))
  const originalState = process.env.XDG_STATE_HOME
  process.env.XDG_STATE_HOME = state
  const dir = path.join(state, "opencode-ensemble", "waiters")
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, team), String(process.pid))
  try {
    sendMessage(deps.db, { teamId: team, from: "worker", to: "lead", content: "progress" })
    expect(await wakeLeadIfPending(deps.client, deps.db, team)).toBe(false)
    await onLeadIdle(deps.client, deps.db, team, config)
    expect(wakes(deps)).toHaveLength(1)
  } finally {
    if (originalState === undefined) delete process.env.XDG_STATE_HOME
    else process.env.XDG_STATE_HOME = originalState
    rmSync(state, { recursive: true, force: true })
  }
  deps.db.run("UPDATE team_message SET delivered = 1")
  await onLeadIdle(deps.client, deps.db, team, config)
  expect(wakes(deps)).toHaveLength(2)
})

test("V2 worker broadcast routes the lead's copy exclusively through its inbox", async () => {
  const { executeTeamBroadcast } = await import("../src/tools/team-broadcast")
  const deps = { ...setupDeps(), v2: true }
  Object.assign(deps.client, { leadWaiter: false })
  insertTeam(deps.db, "broadcast", "test", "lead")
  insertMember(deps.db, "broadcast", "sender", "sender")
  insertMember(deps.db, "broadcast", "recipient", "recipient")
  deps.registry.register("broadcast", "sender", "sender")
  deps.registry.register("broadcast", "recipient", "recipient")
  await executeTeamBroadcast(deps, { text: "broadcast payload" }, "sender")
  expect(wakes(deps).filter(wake => wake.sessionID === "lead").map(wake => wake.synthetic)).toEqual([true])
  expect(wakes(deps).filter(wake => wake.sessionID === "recipient")).toHaveLength(1)
  expect((await executeTeamResults(deps, {}, "lead")).match(/broadcast payload/g)).toHaveLength(1)
  expect(await executeTeamResults(deps, {}, "lead")).toBe("No unread messages.")
  expect(deps.db.query("SELECT to_name FROM team_message ORDER BY to_name").all()).toEqual([{ to_name: null }, { to_name: "lead" }])
})

test("V2 uses one persistent wake claim across two database connections", async () => {
  const { createDb } = await import("../src/db")
  const dir = mkdtempSync(path.join(os.tmpdir(), "ensemble-wake-claim-"))
  const file = path.join(dir, "test.db")
  const a = setupDeps(createDb(file))
  const b = setupDeps(createDb(file))
  try {
    Object.assign(a.client, { leadWaiter: false })
    Object.assign(b.client, { leadWaiter: false })
    insertTeam(a.db, "claim", "claim", "lead")
    for (const from of ["one", "two", "three", "four", "five"]) {
      sendMessage(a.db, { teamId: "claim", from, to: "lead", content: "result" })
    }
    expect(await Promise.all([
      wakeLeadIfPending(a.client, a.db, "claim"),
      wakeLeadIfPending(b.client, b.db, "claim"),
    ])).toEqual([true, false])
    expect([...wakes(a), ...wakes(b)]).toHaveLength(1)
    expect(wakes(a)[0]?.parts[0]?.text).toContain("5 new team message")
  } finally {
    a.db.close()
    b.db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

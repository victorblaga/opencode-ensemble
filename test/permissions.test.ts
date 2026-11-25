import { expect, test } from "bun:test"
import { evaluate, matches, registerPermissionPolicy, type Rule } from "../src/permissions"
import type { V2SetupContext } from "../src/v2-setup"
import { insertMember, insertTeam, setupDeps } from "./helpers"

test("matches OpenCode wildcards, separators, bare commands and multi-line resources", () => {
  expect(matches("C:\\work\\a.ts", "C:/work/?.ts")).toBe(true)
  expect(matches("C:/work/a.ts", "C:\\work\\?.ts")).toBe(true)
  expect(matches("C:/work/aa.ts", "C:/work/?.ts")).toBe(false)
  expect(matches("git", "git *")).toBe(true)
  expect(matches("git status", "git *")).toBe(true)
  expect(matches("gitx", "git *")).toBe(false)
  expect(matches("git status\ngit diff", "git *")).toBe(true)
  expect(evaluate([], "read", "file")).toBe("ask")
})

test("the hook applies the lead's current rules to direct teammates and descendants", async () => {
  const deps = setupDeps()
  insertTeam(deps.db, "team", "alpha", "lead")
  insertMember(deps.db, "team", "worker", "worker", "busy")
  type Event = { sessionID: string; action: string; resources: string[]; effect: Rule["effect"]; message?: string }
  let hook: ((event: Event) => Promise<void>) | undefined
  let rules: Rule[] = []
  let unavailable = false
  const ctx = {
    session: {
      get: async ({ sessionID }: { sessionID: string }) => {
        if (sessionID === "lead") {
          if (unavailable) throw new Error("lookup failed")
          return { permissions: rules }
        }
        if (sessionID === "descendant") return { parentID: "parent" }
        if (sessionID === "parent") return { parentID: "worker" }
        return {}
      },
    },
    permission: {
      hook: async (name: string, cb: typeof hook) => {
        expect(name).toBe("evaluate")
        hook = cb
        return { dispose: async () => undefined }
      },
    },
  } as unknown as V2SetupContext
  await registerPermissionPolicy(ctx, deps.db, deps.registry)
  async function decision(sessionID: string, effect: Rule["effect"], resources = ["rm -rf x"]) {
    const event: Event = { sessionID, action: "shell", resources, effect }
    await hook?.(event)
    return event
  }
  expect(hook).toBeDefined()
  for (const session of ["worker", "descendant"]) {
    rules = [{ action: "*", resource: "*", effect: "allow" }]
    expect((await decision(session, "ask")).effect).toBe("allow")
    rules.push({ action: "shell", resource: "rm *", effect: "deny" })
    expect((await decision(session, "allow", ["pwd", "rm -rf x"])).effect).toBe("deny")
    expect((await decision(session, "ask")).effect).toBe("deny")
    rules = []
    expect(await decision(session, "ask")).toMatchObject({ effect: "deny", message: expect.stringContaining("Nobody can approve") })
    expect((await decision(session, "allow")).effect).toBe("allow")
    unavailable = true
    expect((await decision(session, "ask")).effect).toBe("deny")
    expect((await decision(session, "allow")).effect).toBe("allow")
    unavailable = false
  }
  expect((await decision("unrelated", "ask")).effect).toBe("ask")
  expect((await decision("lead", "ask")).effect).toBe("ask")
})

test("resolves wrapped agent rules at the lead's location and keeps session rules last", async () => {
  const deps = setupDeps()
  insertTeam(deps.db, "team", "alpha", "lead")
  insertMember(deps.db, "team", "worker", "worker", "busy")
  const location = { directory: "/lead" }
  const agentInputs: unknown[] = []
  const leadRules: Rule[] = []
  type Event = { sessionID: string; action: string; resources: string[]; effect: Rule["effect"] }
  let hook: ((event: Event) => Promise<void>) | undefined
  const ctx = {
    location: { directory: "/worker" },
    session: { get: async () => ({ id: "lead", agent: "lead-agent", permissions: leadRules, location }) },
    agent: {
      get: async (input: unknown) => {
        agentInputs.push(input)
        return { location, data: { id: "lead-agent", permissions: [{ action: "read", resource: "*", effect: "deny" }] } }
      },
    },
    permission: { hook: async (_name: string, cb: typeof hook) => { hook = cb } },
  } as unknown as V2SetupContext
  await registerPermissionPolicy(ctx, deps.db, deps.registry)
  const event: Event = { sessionID: "worker", action: "read", resources: ["example.txt"], effect: "allow" }
  await hook?.(event)
  expect(event.effect).toBe("deny")
  expect(agentInputs).toEqual([{ agentID: "lead-agent", location }])
  leadRules.push({ action: "read", resource: "example.txt", effect: "allow" })
  const later: Event = { ...event, effect: "ask" }
  await hook?.(later)
  expect(later).toMatchObject({ effect: "allow" })
})

test("permission evaluation skips session lookup without a team and caches unrelated parent lookup", async () => {
  const deps = setupDeps()
  let reads = 0
  type Event = { sessionID: string; action: string; resources: string[]; effect: Rule["effect"] }
  let hook: ((event: Event) => Promise<void>) | undefined
  const ctx = {
    session: { get: async () => { reads++; return { id: "unrelated" } } },
    permission: { hook: async (_name: string, cb: typeof hook) => { hook = cb } },
  } as unknown as V2SetupContext
  await registerPermissionPolicy(ctx, deps.db, deps.registry)
  const event: Event = { sessionID: "unrelated", action: "read", resources: ["example.txt"], effect: "ask" }
  await hook?.(event)
  expect(reads).toBe(0)
  insertTeam(deps.db, "team", "alpha", "lead")
  insertMember(deps.db, "team", "worker", "worker")
  await hook?.(event)
  await hook?.(event)
  expect(reads).toBe(1)
  expect(event.effect).toBe("ask")
})

test("permission logging records only changed decisions", async () => {
  const { mkdtempSync, readFileSync, rmSync } = await import("node:fs")
  const { tmpdir } = await import("node:os")
  const { join } = await import("node:path")
  const { logPath } = await import("../src/log")
  const deps = setupDeps()
  insertTeam(deps.db, "logs", "alpha", "lead")
  insertMember(deps.db, "logs", "worker", "worker")
  type Event = { sessionID: string; action: string; resources: string[]; effect: Rule["effect"] }
  let hook: ((event: Event) => Promise<void>) | undefined
  const ctx = {
    session: { get: async () => ({ id: "lead", permissions: [{ action: "*", resource: "*", effect: "allow" }] }) },
    permission: { hook: async (_name: string, cb: typeof hook) => { hook = cb } },
  } as unknown as V2SetupContext

  const state = mkdtempSync(join(tmpdir(), "ensemble-permission-log-"))
  const original = process.env.XDG_STATE_HOME
  process.env.XDG_STATE_HOME = state
  try {
    await registerPermissionPolicy(ctx, deps.db, deps.registry)
    const base = { sessionID: "worker", action: "read", resources: ["private-resource"] }
    await hook?.({ ...base, effect: "allow" })
    await hook?.({ ...base, effect: "ask" })
    await hook?.({ ...base, effect: "allow" })
    const entries = readFileSync(logPath(), "utf8").trim().split("\n")
    expect(entries).toHaveLength(1)
    expect(entries[0]).toContain("action=read decision=allow")
    expect(entries[0]).not.toContain("private-resource")
  } finally {
    if (original === undefined) delete process.env.XDG_STATE_HOME
    else process.env.XDG_STATE_HOME = original
    rmSync(state, { recursive: true, force: true })
  }
})

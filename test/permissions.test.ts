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

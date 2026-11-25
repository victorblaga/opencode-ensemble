import { expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createDb } from "../src/db"
import { sendMessage, suppressMessageWake } from "../src/messaging"
import { insertMember, insertTeam } from "./helpers"

// Load the real script in a subprocess with shorter test constants.
const waiter = `
import runpy, sys
script = runpy.run_path(sys.argv.pop(1))
script["poll"].__globals__.update(POLL_SECONDS=0.02, BATCH_SECONDS=0.15)
raise SystemExit(script["main"]())
`

function runWaiter(state: string, dbPath: string, team: string, ...args: string[]) {
  const proc = Bun.spawn(["python3", "-c", waiter, "bin/ensemble-wait.py", "--db", dbPath, ...args], {
    env: { ...process.env, HOME: state, XDG_STATE_HOME: state, OPENCODE_SESSION_ID: `lead-${team}` },
    stdout: "pipe",
    stderr: "pipe",
  })
  return { proc, text: new Response(proc.stdout).text() }
}

test("waiter claims its pid, batches messages, waits through shutdown and exits cleanly", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ensemble-waiter-"))
  const dbPath = join(dir, "test.db")
  const db = createDb(dbPath)
  const pidDir = join(dir, "opencode-ensemble", "waiters")
  const children: ReturnType<typeof runWaiter>[] = []
  const run = (team: string, ...args: string[]) => runWaiter(dir, dbPath, team, ...args)
  try {
    mkdirSync(pidDir, { recursive: true })
    insertTeam(db, "message", "Message", "lead-message")
    insertTeam(db, "quiet", "Quiet", "lead-quiet")
    insertTeam(db, "closed", "Closed", "lead-closed")
    for (const team of ["message", "quiet", "closed"]) insertMember(db, team, "worker", `worker-${team}`, "shutdown_requested")
    const stale = join(pidDir, "message")
    writeFileSync(stale, "0")
    const started = performance.now()
    const message = run("message")
    const quiet = run("quiet")
    const closed = run("closed")
    children.push(message, quiet, closed)
    const until = performance.now() + 3000
    while (
      (!existsSync(join(pidDir, "quiet")) || !existsSync(join(pidDir, "closed")) ||
        !existsSync(stale) || readFileSync(stale, "utf8").trim() !== String(message.proc.pid)) &&
      performance.now() < until
    ) await Bun.sleep(20)
    expect(readFileSync(stale, "utf8").trim()).toBe(String(message.proc.pid))
    const duplicate = run("message")
    expect(await duplicate.text).toContain("already running")
    expect(readFileSync(stale, "utf8").trim()).toBe(String(message.proc.pid))
    const suppressed = sendMessage(db, { teamId: "quiet", from: "worker", to: "lead", content: "ack" })
    suppressMessageWake(db, suppressed)
    sendMessage(db, { teamId: "message", from: "worker", to: "lead", content: "result" })
    db.run("UPDATE team SET status = 'archived' WHERE id = 'closed'")
    expect(await closed.text).toContain("Closed: closed")
    expect(quiet.proc.exitCode).toBeNull()
    db.run("UPDATE team_member SET status = 'shutdown' WHERE team_id = 'quiet'")
    expect(await message.text).toContain("Message: messages")
    expect(performance.now() - started).toBeGreaterThanOrEqual(150)
    expect(await quiet.text).toContain("Quiet: quiet.")
    expect(existsSync(stale)).toBe(false)
    expect(existsSync(join(pidDir, "quiet"))).toBe(false)
    expect(existsSync(join(pidDir, "closed"))).toBe(false)
    const timeout = run("message", "--max-minutes", "0")
    expect(await timeout.text).toContain("Message: timeout")
    expect(await timeout.proc.exited).toBe(0)
    const unknown = run("unknown")
    expect(await unknown.text).toContain("no active Ensemble team")
    expect(await unknown.proc.exited).toBe(2)
    expect(existsSync(stale)).toBe(false)
  } finally {
    for (const child of children) if (child.proc.exitCode === null) child.proc.kill()
    await Promise.all(children.map(child => child.proc.exited))
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test("waiter releases its pid file when the team host dies or changes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ensemble-waiter-host-"))
  const dbPath = join(dir, "test.db")
  const db = createDb(dbPath)
  const file = join(dir, "opencode-ensemble", "waiters", "host")
  try {
    insertTeam(db, "host", "Host", "lead-host")
    insertMember(db, "host", "worker", "worker", "busy")
    for (const next of [2147483647, process.ppid]) {
      db.run("UPDATE team SET host_pid = ?", [process.pid])
      const waiting = runWaiter(dir, dbPath, "host", "--max-minutes", "0.02")
      const deadline = performance.now() + 800
      while (!existsSync(file) && performance.now() < deadline) await Bun.sleep(10)
      expect(existsSync(file)).toBe(true)
      db.run("UPDATE team SET host_pid = ?", [next])
      expect(await waiting.text).toContain("Host: host down")
      expect(await waiting.proc.exited).toBe(0)
      expect(existsSync(file)).toBe(false)
    }
    db.run("UPDATE team SET host_pid = 2147483647")
    const orphan = runWaiter(dir, dbPath, "host", "--max-minutes", "0.02")
    expect(await orphan.text).toContain("Host: host down")
    expect(existsSync(file)).toBe(false)
    db.run("UPDATE team SET host_pid = ?", [process.pid])
    const resumed = runWaiter(dir, dbPath, "host", "--max-minutes", "0")
    expect(await resumed.text).toContain("Host: timeout")
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

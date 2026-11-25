import { expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createDb } from "../src/db"
import { sendMessage, suppressMessageWake } from "../src/messaging"
import { insertMember, insertTeam } from "./helpers"

test("waiter claims its pid, batches messages, waits through shutdown and exits cleanly", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ensemble-waiter-"))
  const dbPath = join(dir, "test.db")
  const db = createDb(dbPath)
  const pidDir = join(dir, "opencode-ensemble", "waiters")
  const children: ReturnType<typeof run>[] = []
  function run(team: string, ...args: string[]) {
    const proc = Bun.spawn(["python3", "bin/ensemble-wait.py", "--db", dbPath, ...args], {
      env: { ...process.env, HOME: dir, XDG_STATE_HOME: dir, OPENCODE_SESSION_ID: `lead-${team}` },
      stdout: "pipe",
      stderr: "pipe",
    })
    return { proc, text: new Response(proc.stdout).text() }
  }
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
    expect(performance.now() - started).toBeGreaterThanOrEqual(15000)
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
}, 25000)

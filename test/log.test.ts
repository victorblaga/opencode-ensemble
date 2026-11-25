import { expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { log } from "../src/log"

test("logs time and pid, rotates again in the same process, and tolerates an inaccessible state path", () => {
  const dir = mkdtempSync(join(tmpdir(), "ensemble-log-"))
  const original = process.env.XDG_STATE_HOME
  try {
    process.env.XDG_STATE_HOME = dir
    const logDir = join(dir, "opencode-ensemble")
    const file = join(logDir, "ensemble.log")
    mkdirSync(logDir)
    writeFileSync(file, Buffer.alloc(5 * 1024 * 1024 + 1))
    log("first")
    expect(readFileSync(file, "utf8")).toMatch(new RegExp(`^\\d{4}-\\d{2}-\\d{2}T.* pid=${process.pid} first\\n$`))
    expect(readFileSync(file + ".1").length).toBe(5 * 1024 * 1024 + 1)
    writeFileSync(file, Buffer.alloc(6 * 1024 * 1024))
    log("second")
    expect(readFileSync(file + ".1").length).toBe(6 * 1024 * 1024)
    expect(readFileSync(file, "utf8")).toContain(" second")
    process.env.XDG_STATE_HOME = file
    expect(() => log("cannot write here")).not.toThrow()
  } finally {
    if (original === undefined) delete process.env.XDG_STATE_HOME
    else process.env.XDG_STATE_HOME = original
    rmSync(dir, { recursive: true, force: true })
  }
})

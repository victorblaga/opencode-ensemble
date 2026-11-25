import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

let client: { app: { log: (params: { service: string; level: string; message: string }) => Promise<unknown> } } | null = null
let rotatedPath: string | undefined

export function logPath(env: Record<string, string | undefined> = process.env): string {
  return join(env.XDG_STATE_HOME || join(env.HOME || homedir(), ".local", "state"), "opencode-ensemble", "ensemble.log")
}

export function initLog(rawClient: unknown): void {
  client = rawClient as typeof client
}

/** Write to the plugin log and, on V1, mirror to OpenCode. */
export function log(msg: string): void {
  try {
    const file = logPath()
    mkdirSync(dirname(file), { recursive: true })
    if (rotatedPath !== file) {
      rotatedPath = file
      if ((statSync(file, { throwIfNoEntry: false })?.size ?? 0) > 5 * 1024 * 1024) {
        renameSync(file, `${file}.1`)
      }
    }
    appendFileSync(file, `${new Date().toISOString()} pid=${process.pid} ${msg.replace(/[\r\n]/g, " ")}\n`)
  } catch { /* Logging must not interrupt plugin work. */ }
  try {
    client?.app.log({ service: "ensemble", level: "info", message: msg }).catch(() => {})
  } catch { /* The host log is best effort. */ }
}

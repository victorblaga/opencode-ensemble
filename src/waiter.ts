import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import type { EnsembleConfig } from "./config"
import type { Database } from "./db"
import { pidAlive } from "./host"
import { logPath } from "./log"

export function waiterRequired(config: Required<EnsembleConfig>, env = process.env): boolean {
  return config.leadWaiter === "always"
    || (config.leadWaiter === "auto" && Object.keys(env).some(key => key.startsWith("T3CODE_")))
}

export function waiterAlive(teamId: string): boolean {
  try {
    const file = join(dirname(logPath()), "waiters", teamId)
    return pidAlive(Number(readFileSync(file, "utf8").trim()))
  } catch {
    return false
  }
}

export function waiterCommand(): string {
  const script = fileURLToPath(new URL("../bin/ensemble-wait.py", import.meta.url))
  return `python3 '${script.replaceAll("'", "'\\''")}'`
}

export function workingCount(db: Database, teamId: string): number {
  return (db.query("SELECT COUNT(*) AS count FROM team_member WHERE team_id = ? AND status IN ('busy', 'shutdown_requested')")
    .get(teamId) as { count: number }).count
}

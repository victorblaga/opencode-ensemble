import { expect, test } from "bun:test"
import { executeTeamStatus } from "../src/tools/team-status"
import { executeTeamCreate } from "../src/tools/team-create"
import { insertMember, insertTeam, setupDeps } from "./helpers"

test("only the returning lead can adopt a team, once and atomically", async () => {
  const deps = { ...setupDeps(), v2: true }
  const { db } = deps
  insertTeam(db, "t", "alpha", "lead-session")
  insertMember(db, "t", "busy", "busy-session", "busy", "running")
  insertMember(db, "t", "stopping", "stopping-session", "shutdown_requested", "cancel_requested")
  db.run("UPDATE team SET host_pid = NULL")
  db.run("INSERT INTO team_task (id, team_id, content, assignee, status, time_created, time_updated) VALUES ('task', 't', 'test', 'stopping', 'in_progress', 1, 1)")
  await expect(Promise.resolve().then(() => executeTeamStatus(deps, "busy-session"))).rejects.toThrow("lead has to return")
  expect(db.query("SELECT host_pid FROM team").get()).toEqual({ host_pid: null })
  db.exec("CREATE TRIGGER reject_notice BEFORE INSERT ON team_message BEGIN SELECT RAISE(ABORT, 'notice failed'); END")
  await expect(Promise.resolve().then(() => executeTeamStatus(deps, "lead-session"))).rejects.toThrow("notice failed")
  expect(db.query("SELECT host_pid FROM team").get()).toEqual({ host_pid: null })
  expect(db.query("SELECT status FROM team_task").get()).toEqual({ status: "in_progress" })
  db.exec("DROP TRIGGER reject_notice")
  await executeTeamStatus(deps, "lead-session")
  await executeTeamStatus(deps, "lead-session")
  expect(db.query("SELECT host_pid, lead_status FROM team").get()).toEqual({ host_pid: process.pid, lead_status: "busy" })
  expect(db.query("SELECT status, execution_status FROM team_member ORDER BY name").all()).toEqual([
    { status: "ready", execution_status: "cancelled" },
    { status: "shutdown", execution_status: "cancelled" },
  ])
  expect(db.query("SELECT assignee, status FROM team_task").get()).toEqual({ assignee: null, status: "pending" })
  expect(db.query("SELECT from_name, to_name FROM team_message").all()).toEqual([{ from_name: "system", to_name: "lead" }])
})

test("a live foreign host blocks tools and same-name reconciliation", async () => {
  const deps = { ...setupDeps(), v2: true }
  insertTeam(deps.db, "t", "alpha", "lead-session")
  deps.db.run("UPDATE team SET host_pid = ?", [process.ppid])
  deps.client.session.get = async () => { throw new Error("session not found") }
  await expect(Promise.resolve().then(() => executeTeamStatus(deps, "lead-session"))).rejects.toThrow("another OpenCode server")
  await expect(executeTeamCreate(deps, { name: "alpha" }, "another-session")).rejects.toThrow("already exists")
  expect(deps.db.query("SELECT status FROM team").all()).toEqual([{ status: "active" }])
})

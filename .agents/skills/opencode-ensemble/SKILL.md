---
name: opencode-ensemble
description: "Use when coordinating multiple coding agents, delegating independent software work, managing OpenCode Ensemble teams, choosing teammate roles or models, reviewing teammate output, or deciding whether parallel execution is appropriate."
license: MIT
metadata:
  author: hueyexe
  version: "1.2.0"
---

# OpenCode Ensemble

Use this skill in OpenCode with the Ensemble plugin installed. The lead owns decomposition, sequencing, review, merge, and verification.

## Core Principle

Spawn teammates only for independent, verifiable work. A good Ensemble team has narrow task ownership, clear dependencies, and a lead that integrates results deliberately.

## Use Ensemble When

- Work can be split into independent research, implementation, test, or review slices.
- A read-only scout can map unfamiliar code before edits begin.
- Multiple files or subsystems can be changed without overlapping ownership.
- A risky change benefits from `plan_approval: true` before edits.
- A final reviewer can inspect merged changes without creating another branch.

## Do Not Use Ensemble When

- The task is small enough for one agent to finish quickly.
- The work is tightly coupled and every teammate would need the same files.
- The lead cannot describe each teammate's output and success criteria.
- The user needs one coherent design decision rather than parallel exploration.
- You are tempted to spawn agents because the task feels hard but not divisible.

## Lead Workflow

1. Commit the shared contract or baseline in the lead checkout before creating worktrees.
2. Create the team with `team_create`.
3. Add tasks with `team_tasks_add` and set `depends_on` with the IDs it returns.
4. Spawn teammates one at a time with `team_spawn`, an explicit `model`, and the relevant `claim_task`.
5. Use `worktree: false` for read-only `explore` teammates.
6. Use `plan_approval: true` for risky implementation work.
7. Follow the [waiting procedure](#waiting-for-teammates) while teammates work.
8. Read each report before shutdown. Use `team_results` when the full report is needed. A claimed task is complete only after `team_tasks_complete` is called with its ID.
9. Use `team_shutdown` after the teammate finishes and reports. Confirm it has stopped before merging.
10. Keep the Git index clean for `team_merge`. Inspect the unstaged diff, run the relevant checks, and commit before spawning a teammate that depends on those changes.
11. Run project verification, call `team_cleanup`, and report any resources it retained.

## Role Defaults

| Role | Agent | Worktree | Use for |
|---|---|---:|---|
| Scout | `explore` | `false` | Codebase mapping, risk discovery, file ownership |
| Builder | `build` | `true` | Narrow implementation slice |
| QA | `build` | `true` | Tests, fixtures, regression coverage |
| Reviewer | `explore` | `false` | Independent diff review, risks, and missing tests |

Choose an available model for the role and pass its complete ID in the `model` field on every spawn. Start with two or three teammates and add more only when the work has enough independent slices.

## Waiting for Teammates

On a T3-managed OpenCode host, copy the exact `python3 '<plugin path>/bin/ensemble-wait.py'` command from the lead's system prompt. Run it unmodified in the lead session using the `shell` tool with `background: true` after spawning and whenever teammates are still working at turn end. The waiter discovers the team from the lead's session ID. Optionally call `t3_background_wait` with the returned shell ID to show that the thread is working, then end the turn. Wait for the shell to resume the lead and avoid polling.

Read the exit summary and the lead inbox. `messages` means the waiter batched new messages, and `quiet` means no teammate is working or finishing a graceful shutdown. `closed` means the team is inactive or gone. `timeout` is a periodic check-in. An already-running notice means the current waiter is still handling the wait. Use the task board and reports to decide what remains. Start a new waiter before ending the turn if teammates are still working.

## Teammate Permissions

On OpenCode V2, teammates inherit permission decisions from the lead's current rules. An explicit lead denial applies even to a preapproved teammate action. Builders can use their permitted edit and shell tools in their worktree. Read-only reviewers cannot edit files or use the shell. Teammates cannot ask the user questions, request permission approvals, or use T3 orchestration tools. Send blockers to the lead with `team_message`.

## After a Host Restart

One server process owns each team. When that server stops, the returning lead adopts the team on its next turn or team tool call. The recovery message names interrupted teammates. Check their status before deciding which work to resume or merge. Existing sessions and worktrees are retained. Use `team_message` to continue available teammates, or shut them down and merge their work. A live foreign host retains ownership.

## Cleanup

On OpenCode V2, shutdown must be confirmed before merging a teammate's final commit or removing its checkout. If cleanup cannot stop a teammate, it keeps the checkout and reports the blocker. Read the result for preserved branches, retained worktrees, and any operation that needs attention. Use `acknowledge_uncommitted: true` only after deciding to discard uncommitted teammate changes. Purge of archived teams requires the user's approval of the preview and deletes only exact recorded refs belonging to the selected team.

## Load References As Needed

- Need a team shape? Read `references/coordination-patterns.md`.
- Need prompts? Read `references/prompt-recipes.md`.
- Need a pre-spawn, merge, cleanup, or verification gate? Read `references/lead-checklists.md`.
- Something feels off or too chatty? Read `references/anti-patterns.md`.
- Creating or improving this skill? Read `references/eval-scenarios.md`.

## Hard Rules

- Do not invent task IDs. `team_tasks_add` generates IDs; use the IDs returned by earlier calls when setting `depends_on` or `claim_task`.
- Keep teammate prompts short. The plugin already injects team role, allowed tools, worktree context, and the required task-result format.
- Do not give teammates vague prompts like "fix the bug" or "work on tests".
- Do not ask teammates to use lead-only tools such as `team_spawn`, `team_shutdown`, `team_merge`, or `team_cleanup`.
- Do not tell teammates to report only in plain text. They must use `team_message`.
- Commit the lead baseline before spawning worktree teammates. Shut teammates down after their reports, keep the index clean for `team_merge`, and inspect the resulting diff.
- Keep OpenCode CLI and HTTP API calls out of agent shells. Use the session's own tools for team operations.
- Do not call the work complete until the repository's verification commands pass or you have clearly reported the blocker.
- On OpenCode v2, teammate reports and notifications arrive as persistent synthetic system lines in the transcript, `team_view` switches the TUI only when passed `navigate: true` (never unprompted — that hijacks the user's client), and `team_cleanup` purge needs human approval of the preview before confirmation.

## Minimal Example

Use these IDs if your providers expose them, or substitute available models explicitly.

```ts
team_create({ name: "checkout-idempotency" })

team_tasks_add({
  tasks: [
    { content: "Map checkout webhook flow and risky files", priority: "high" },
    { content: "Implement duplicate-webhook idempotency guard", priority: "high" },
  ],
})
// Record returned IDs, for example: task_abc123 for scout and task_def456 for builder.

team_tasks_add({
  tasks: [
    { content: "Add duplicate-webhook regression tests", priority: "high", depends_on: ["task_def456"] },
  ],
})
// Record returned QA task ID, for example: task_ghi789.

team_tasks_add({
  tasks: [
    { content: "Review merged diff for correctness and missed tests", priority: "medium", depends_on: ["task_def456", "task_ghi789"] },
  ],
})

team_spawn({
  name: "scout",
  agent: "explore",
  worktree: false,
  model: "openai/gpt-5-mini",
  claim_task: "task_abc123",
  prompt: "Trace the checkout webhook flow. Report files, data model, existing tests, risks, and a smallest-safe-change plan. Do not edit files.",
})

team_spawn({
  name: "api-dev",
  agent: "build",
  model: "anthropic/claude-opus-4-7",
  plan_approval: true,
  claim_task: "task_def456",
  prompt: "Use scout's findings to implement only the idempotency guard. Commit your work and send a task-result message with files changed and tests run.",
})
```

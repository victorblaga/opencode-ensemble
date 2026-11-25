---
name: ensemble-swarm
description: Launch and coordinate an OpenCode Ensemble team from T3 Code for software work with independent, verifiable slices.
---

# Ensemble Swarm

Use Ensemble for tasks that support two to four builders with disjoint file ownership and runnable checks. Resolve shared design decisions before launching builders.

## Models

| Role | Default |
| --- | --- |
| Lead | `openai/gpt-6.2-astra`, variant `high` |
| Builders and QA | `opencode-go/deepseek-v4.1-flash#high` |
| Independent reviewer | `openai/gpt-6.2-astra#high`, agent `explore`, `worktree: false` |

If the user asks for Fable as lead, use `claude-agent/claude-fable-5-2` with variant `high`; keep the Astra reviewer. Honor explicit model choices. Give each `team_spawn` an explicit model and use a different model family from the builders for independent review.

## Launch From T3 Code

1. Resolve the target checkout with `git rev-parse --show-toplevel`. Find a T3 project with exactly that root using `t3_project_list`, or register the repo or existing worktree using `t3_project_create` with `workspaceRoot`. In a multi-repo project, target the repository itself. For greenfield work, create a project with just `title` and verify `git rev-parse HEAD` in its root before launching. Resolve any `commitError` under the project's Git rules first.
2. Call `t3_thread_launch` with this project's `projectId`, a title and a tailored lead prompt. Use `workspaceStrategy: { type: "root" }` to run in a registered checkout or existing worktree. For a new worktree from a repository project, use `{ type: "worktree", baseRef, startFromOrigin }` and honor the requested base. Use the remote default branch for independent work and a local base for unpublished prerequisites or when the repo has no remote.
3. Set `modelSelection: { provider: "opencode", instanceId: "opencode", model: "<selected lead model>", options: { variant: "high" } }`, using the variant the user requests if different. Use `runtimeMode: "full-access"` when the caller's permissions permit it and `interactionMode: "default"`.
4. Return the thread's `link` verbatim and dashboard URL `http://127.0.0.1:4747`. Leave the thread to run asynchronously.

If `team_*` tools are available in the current OpenCode session, use that session. Read the installed `~/.config/opencode/skills/opencode-ensemble/SKILL.md` and run the phases below directly.

## Guardrails

- Follow the target repository's instructions for the lead and all teammates. In Pfizer repositories, read `~/work/pfizer/agent-instructions/<repo>.md` before working.
- Keep secrets out of thread and teammate prompts.
- Keep OpenCode CLI and HTTP API calls out of agent shells. Use the OpenCode session tools and the T3 thread tools.
- Keep the plugin pin and OpenCode configuration stable while a team is active.

## Lead Prompt Blueprint

Adapt the following to the task with the actual repository, ownership boundaries, model selections, and verification commands.

```text
Execute <task> with OpenCode Ensemble. Read the opencode-ensemble skill and the target repository instructions first.

1. Establish a baseline. Commit the shared interfaces or baseline before team_create so workers start from the same HEAD.
2. Build the task board. Add two to four independent build tasks, each with disjoint file ownership and runnable acceptance checks. Record their IDs, make QA depend on the build tasks, and make review depend on QA.
3. Spawn builders one at a time with agent build, worktree true, their explicit model, and claim_task. Give each builder its owned files, interface, and checks. Have each commit its work, call team_tasks_complete with its task ID, and report to the lead with team_message. A report alone leaves the task open.
4. When ending a turn with teammates still working, copy the exact waiter command from the plugin prompt. Start it in the lead's shell with background: true, optionally pass its shell ID to t3_background_wait, and end the turn. Use the exit summary and inbox on resume. After host recovery, follow the plugin's notice and use team_message to continue available teammates in their existing sessions.
5. Read each builder's report, then shut it down. With shutdown confirmed and the index clean, run team_merge, inspect and test the integrated diff, and commit it before spawning QA. Give QA its explicit model, a worktree, and claim_task. Read its report, confirm shutdown, merge, and commit the verified checkpoint.
6. Spawn a read-only reviewer with agent explore, worktree false, an explicit reviewer model, and claim_task. Ask it to inspect the integrated diff and test coverage, complete its task on the board, and report findings through team_message. Fix demonstrated issues and rerun the relevant checks.
7. Shut down remaining teammates, call team_cleanup, and report the result, exact checks, and any retained worktrees or branches.
```

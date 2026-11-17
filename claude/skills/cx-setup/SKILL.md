---
name: cx-setup
description: Interview the user and inspect the current project, then write a cx.config.yaml for the cx parallel-feature harness. Use when the user wants to set up cx, pick a preset, or tailor phases, worktrees, stack mode, checks, and guards to this repository.
---

# cx setup

Write a project config for `cx`. Infer what you can from the tree. Ask only what you cannot infer. Do not mention any one company's layout; this skill is for whatever repository is in front of you.

## Steps

1. Run `cx inspect` in the project root and read the JSON. Also run `cx config schema` if you need the allowed keys.
2. Tell the user, in a short list, what you inferred: single repo or several repos, package manager, likely check command, base branch, compose files, existing task folders, worktree folders, and whether Superpowers, Graphify, GitNexus, or claude-mem showed up.
3. Ask only the questions in the inspect `questions` array, plus anything that is still ambiguous after that. Typical leftovers:
   - where worktrees should live, if the user already has a convention outside the repo
   - whether a compose file is unused, one stack per lane, or a shared stack behind a wrapper command
   - which long-lived branch is the base
   - which human gates they want (`plan`, `commit`, `push`, `pr`)
4. Draft the config.
   - Prefer `cx init --preset single-repo` or `cx init --preset multi-repo`, then edit the file.
   - Or run `cx init --from-inspect` and edit the draft.
   - Do not start from a preset that names a specific organization.
5. Map phases to installed skills when inspect says they exist (`superpowers:brainstorming`, `superpowers:writing-plans`, `superpowers:test-driven-development`, `superpowers:requesting-code-review`). When a skill is absent, set `prompt: builtin:<phase>` and say so.
6. If the user wants a phase to behave differently, write a short prompt under `.cx/prompts/` and point `phases[].prompt` at it. Keep prompts free of secrets.
7. Run `cx config validate` and `cx doctor`. Fix errors. Leave warnings that are only "tool not installed" as notes.
8. Summarize the choices: layout, task folder, worktree pattern, stack mode, queue, gates, and which guards you enabled.

## Rules

- Never put passwords, tokens, or `.env` contents into the config, a prompt, or your reply.
- Never weaken `guards` to make a later command succeed. Add rules when the user wants them; do not delete a safety rule to unblock yourself.
- `cx approve` stays a human action. Do not run it.
- If a check command is not obvious, leave it empty or use the value the user gives. Do not invent a test command that is not in package.json, the Makefile, or the user's answer.
- Shared stack mode needs a wrapper command the user names. Do not guess a script path that is not on disk.
- After writing the file, stop. Do not start a task unless the user asks.

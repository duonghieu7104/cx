---
description: Run the cx phase pipeline for one task until the next human gate
argument-hint: "<task> [--auto-plan] [--until <phase>]"
---

Run the cx pipeline for the task named in $ARGUMENTS.

1. Run `cx status <task> --json` and `cx phases`. The enabled phases in the project config are the pipeline. Do not invent extra stages and do not skip a phase the config enabled.
2. Continue from the current phase. If the user passed `--auto-plan`, you may run `cx ship <task> --auto-plan`. Otherwise do not pass `--auto-plan`.
3. For an agent phase, use the skill named on that phase when it is installed. Otherwise follow `cx phase prompt <task>`.
   - `cx-implementer` does the execute phase, one lane at a time. Lanes in different repos may be edited together. `cx check` and `cx build` stay on the serial queue.
   - `cx-reviewer` does the review phase in a fresh context. It must end with `VERDICT: GO` or `VERDICT: NO-GO`.
   - `cx-qc` may run `cx test-local`. It does not edit code.
4. Stop when the phase is a human gate. Print the task summary, the report path if one exists, and the exact `cx approve` command a person would type. Do not run `cx approve`. Do not commit, push, or open a pull request.
5. On `VERDICT: NO-GO`, go back to execute. After the configured round limit, leave the task blocked and stop.
6. Do not read `.env` files or print secrets. Do not call the stack wrapper yourself; use `cx stack` commands.

You can also let the CLI walk the phases: `cx ship <task>`. Use that when the user wants the harness to invoke the agent for each phase.

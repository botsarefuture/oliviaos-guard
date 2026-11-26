---
name: oliviaos-guard
description: How to work with the oliviaos-guard mod, which enforces the OliviaOS Rule in every Claude Code session. Use when a tool call or question is refused with "oliviaos-guard:", when the status line shows "OliviaOS · … blocked", or when Olivia asks what the guard does, what it blocked, or how to get past a block for a good reason.
---

# oliviaos-guard

The guard is a set of hooks that runs in every session where this plugin is on. It
enforces the OliviaOS Rule; it does not replace it. The full rules come live from
the OliviaOS connector's `rules_get` and are in your system prompt.

## What it does

- **Hard stops (refused):** opening or writing `/var/lib/pve-cluster/*.db` over SSH;
  `pkill -f <pattern>` over SSH; daytime (08–23 Helsinki) `mongodump`/`pg_dump`/
  `mysqldump` on a prod host; rebooting a prod host.
- **Logs every state change** that succeeded (remote systemctl/docker/qm/rm…,
  `git push`, rsync, scp, deploys) to `~/.oliviaos/decisions.md` and sends it to
  OliviaOS with `report_work`. Secrets are redacted first.
- **Logs and reports every block too** (class `blocked`), with what and why.
- **Autonomy:** a question to Olivia that asks permission ("should I…", "want me
  to…") is refused unless it starts with `IRREVERSIBLE+LIVE:`.
- **Night guard, 23:00–08:00 Helsinki:** no questions, no phone notifications, no
  blocking `ask_olivia`. A factual question is allowed while Olivia is chatting.
- **Infra map first:** an infrastructure prompt gets a reminder to call `infra_get` (and `infra_observed` for live facts) before answering or acting; never answer infra questions from memory. It never blocks. The log records whether the map was loaded.
- **No permission questions:** the next-step box (`wrap_up` ask) and yes / no `AskUserQuestion` are refused for reversible work. Do the work and report it; do not move the question into your closing text.
- **Model tiering:** an `Agent` or `start_session` call with no model gets the cheapest that fits: Haiku for read-only work (search, read, status, summaries, Explore), Sonnet by default, and no change (inherits) for architecture, security/auth, planning or hard debugging. A model you set is never changed; forks are left alone.
- **Briefs:** adds the OliviaOS carry-forward line to every subagent and session
  brief that lacks it.

## When you are blocked

The deny text says why and what to do instead. Do that; do not reword the command
to slip past the check.

- `pkill -f` over SSH: use a bracketed pattern that cannot match its own shell
  (`pkill -f '[n]ode server'`), a PID from `pgrep -a`, or `systemctl stop <unit>`.
- Proxmox cluster db: read the folder (`ls`, `stat`) or use `pvesh`, `qm config`,
  `vzdump`.
- Prod DB dump in the day: run it 23:00–08:00, or dump from a replica or snapshot.
- Prod reboot: reload or restart the one service first. If the box is truly
  wedged, log why with `~/.oliviaos/scripts/log`, then add `OLIVIAOS_HARD_RESTART=1`
  to the command.
- Permission question: decide reversible work yourself and report after. Ask only
  when it is irreversible + Live with no backup possible, starting the question
  with `IRREVERSIBLE+LIVE:` and saying why.
- Night: contain only (stop, pause, roll back) and put the real decision in
  `report_work` and a non-blocking `ask_olivia` with your `default_action`.

## Where to look

- Status line: `OliviaOS · N logged · N sent (N queued) · M blocked · night`.
- Every entry: `~/.oliviaos/decisions.md` and the OliviaOS inbox.
- Source: `guard/` in https://github.com/botsarefuture/oliviaos-skill.

# oliviaos-guard

Turns the OliviaOS Rule (`~/.oliviaos/RULES.md`) from text into hooks, so no session has to remember it.

- **HARD STOPS denied**: live `/var/lib/pve-cluster/` access, `pkill -f` over SSH, daytime DB dumps on prod (08–23 Helsinki), prod reboots without `OLIVIAOS_HARD_RESTART=1`.
- **Auto-log**: successful state-changing Bash commands (remote systemctl/docker/qm/rm…, git push, rsync, scp, deploys) go to `~/.oliviaos/decisions.md` via `~/.oliviaos/scripts/log`, class `auto-logged`, secrets redacted.
- **Carry-forward**: every `Agent` and `start_session` brief gets the OliviaOS rule + caveman + model-tiering line if missing.
- **Model tiering**: subagents and new sessions started without a model get Haiku for read-only work, Sonnet by default; architecture, security/auth, planning and hard debugging keep the session's model. A model that is set is never changed.
- **Infra map first**: a prompt about infrastructure (generic words, or host names learned from earlier `infra_get` results, stored only on your machine) gets a short reminder to call `infra_get` until the map is loaded. Server actions are logged with `infra map loaded first: yes/no`, and once per session an `infra-check` entry says whether the map was loaded before an infra answer. Reminder only, never blocks; the prompt text is not recorded.
- **Status line**: `OliviaOS · N logged · N sent · M blocked · night`.
- **Autonomy, always**: a system-prompt section tells every session to decide reversible work itself. A question to Olivia (AskUserQuestion, blocking `ask_olivia`) that asks permission is refused unless it starts with `IRREVERSIBLE+LIVE:` and says why no backup is possible. Blocking `ask_olivia` with a `default_action` is turned non-blocking.
- **Next-step box and yes/no questions**: a `wrap_up` question or `AskUserQuestion` whose answers are yes / no (or that asks permission in words) is refused unless it starts with `IRREVERSIBLE+LIVE:`. Questions about sending, paying or permanent deletion pass. Plain closing text cannot be blocked.
- **Night guard, 23:00–08:00 Helsinki**: AskUserQuestion, PushNotification and blocking `ask_olivia` are refused. Proactive file sends go quietly. A night section in the system prompt says: decide yourself, contain only (stop, pause, roll back), hold real decisions for the ~10:00 report.

## Install

```bash
claude plugin marketplace add botsarefuture/oliviaos-skill
claude plugin install oliviaos-guard@oliviaos
```

(The `oliviaos` marketplace in `botsarefuture/oliviaos-skill` lists this repo next to the OliviaOS skill. This repo is also a marketplace of its own: `/plugin install oliviaos-guard --marketplace botsarefuture/oliviaos-guard`.)

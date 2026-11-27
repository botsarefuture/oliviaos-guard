import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

// OliviaOS guard: turns ~/.oliviaos/RULES.md from text into hooks.
// 1. Bash HARD STOPS are denied with the reason and what to do instead.
// 2. State-changing Bash commands that succeed are auto-logged to
//    ~/.oliviaos/decisions.md (secrets redacted, class "auto-logged").
// 3. Agent / start_session briefs get the OliviaOS carry-forward line.
// 2b. Each auto-logged change is also sent to OliviaOS (report_work), one
//     report per command; unsent ones queue and go with the next send.
// 4. Every block is logged and reported too (class "blocked"), so Olivia sees
//    what the guard stopped and why.
// 5. Rules come live from the OliviaOS skill's MCP (rules_get), falling back
//    to ~/.oliviaos/RULES.md, and go into every session's system prompt.
// 6. Status line: "OliviaOS · N logged · N sent · M blocked · night".
// 9. Decisions and preferences: briefs for a decision consult get Opus, the
//    system prompt says to consult a stronger model on decisions that matter,
//    ~/.oliviaos/preferences.md goes into every session's system prompt, and a
//    correction from Olivia gets a reminder to record it. Nudges only.
// 8. Infra map first: a prompt about infrastructure gets a reminder to call
//    infra_get until the map is loaded, and the log says whether it was loaded
//    before an infra answer or a server action. Reminder only, never blocks.
// Blocks stay to what the rules need: a read-only look, a safe pattern or
// Olivia being awake lets the command or question through.

const logged = atom({ plugin: 'oliviaos-guard', key: 'logged' } as const, 0, { shape: 'n-1' })
type Report = { title: string; summary: string; what: string; project: string; cls?: string; revert?: string }
const pending = atom({ plugin: 'oliviaos-guard', key: 'pending' } as const, [] as Report[], { shape: 'reports-1' })
const sent = atom({ plugin: 'oliviaos-guard', key: 'sent' } as const, 0, { shape: 'n-1' })
const tieredCount = atom({ plugin: 'oliviaos-guard', key: 'tiered' } as const, 0, { shape: 'n-1' })
const blocked = atom({ plugin: 'oliviaos-guard', key: 'blocked' } as const, 0, { shape: 'n-1' })
const mapLoaded = atom({ plugin: 'oliviaos-guard', key: 'mapLoaded' } as const, false, { shape: 'b-1' })
const caveman = atom({ plugin: 'oliviaos-guard', key: 'caveman' } as const, true, { shape: 'b-1' })
const mapNoted = atom({ plugin: 'oliviaos-guard', key: 'mapNoted' } as const, [] as string[], { shape: 's-1' })

export const CARRY =
  'Follow the OliviaOS Rule in `~/.oliviaos/RULES.md` — decide by reversibility × reach, ' +
  'make irreversible things reversible then do them, ask only for irreversible+Live. ' +
  'Log state changes via `~/.oliviaos/scripts/log`. Use caveman voice. Follow model tiering. ' +
  'Consult a stronger model (advisor / Opus subagent) before decisions that matter. ' +
  'Read `~/.oliviaos/preferences.md` and act on it; her explicit answers win.'

const PROD = /\b(moso-prod|lc-main|lc-db|lc-email|ax41|xeon|prod)\b/i
const SSH = /\bssh\b/
const PVE_TOUCH = /\b(sqlite3|cp|mv|rm|rsync|tar|dd|tee|truncate|vi|vim|nano)\b|sed\s+-i|>\s*\/var\/lib\/pve-cluster/

// ---------- helpers (exported for tests) ----------

export function helsinkiHour(now: Date = new Date()): number {
  try {
    const h = now.toLocaleString('en-GB', { timeZone: 'Europe/Helsinki', hour: '2-digit', hour12: false })
    const n = parseInt(h, 10)
    if (!Number.isNaN(n)) return n % 24
  } catch {}
  // Fallback: EET/EEST approximation (UTC+2 Nov–Mar, UTC+3 Apr–Oct).
  const m = now.getUTCMonth()
  const off = m >= 3 && m <= 9 ? 3 : 2
  return (now.getUTCHours() + off) % 24
}

export const isNight = (hour: number) => hour >= 23 || hour < 8

/**
 * Drops text that is a message, not a command: commit/PR/log messages and
 * heredoc bodies. Without this, writing ABOUT a hard stop gets blocked.
 */
export function commandPart(cmd: string): string {
  return cmd
    .replace(/<<-?\s*['"]?(\w+)['"]?[\s\S]*?\n\1\b/g, ' ')
    .replace(/(\.oliviaos\/scripts\/log)((?:\s+(?:"(?:[^"\\]|\\.)*"|'[^']*'))+)/g, '$1')
    .replace(/(\s(?:-m|--message|--body|--title|--description|-f\s+message=|-f\s+body=|-f\s+title=))\s*(?:"(?:[^"\\]|\\.)*"|'[^']*')/g, '$1 MSG')
    .replace(/(\s(?:-m|--message|--body|--title|-f\s+message=))\s*"\$\(cat[\s\S]*?\)"/g, '$1 MSG')
}

/** Returns a deny reason when the command hits a HARD STOP, else undefined. */
export function hardStop(rawCmd: string, hour: number): string | undefined {
  const cmd = commandPart(rawCmd)
  // Reading is fine (ls, cat, stat, grep). Opening the db or writing into the folder is what locked pmxcfs.
  if (/\/var\/lib\/pve-cluster\//.test(cmd) && SSH.test(cmd) && PVE_TOUCH.test(cmd))
    return 'HARD STOP: never open or write /var/lib/pve-cluster/*.db live (2026-11-20 sqlite lock caused a cluster outage). Reading the folder (ls, stat) is fine. Use Proxmox tooling (vzdump, pvesh, qm config) instead.'

  // pkill -f over SSH matches the remote shell that carries the pattern, so it kills its own session.
  // A bracketed pattern ('[n]ode') cannot match itself and is safe.
  const pk = /\bpkill\s+(?:-[a-zA-Z]+\s+)*?-[a-zA-Z]*f[a-zA-Z]*\s+(?:-[a-zA-Z]+\s+)*['"]?([^\s'";&|()]+)/.exec(cmd)
  const pat = pk?.[1] ?? ''
  if (SSH.test(cmd) && pat && !/\[[^\]]+\]/.test(pat))
    return `HARD STOP: \`pkill -f ${pat}\` over SSH also matches the remote shell running it and kills your own session. Use a bracketed pattern that cannot match itself (pkill -f '[${pat.slice(0, 1)}]${pat.slice(1)}'), a PID from pgrep -a, or systemctl stop <unit>.`

  if (SSH.test(cmd) && PROD.test(cmd) && /\b(mongodump|pg_dump|pg_dumpall|mysqldump)\b/.test(cmd) && !isNight(hour))
    return `HARD STOP: no daytime DB dumps on production (it took the site down). It is ${hour}:00 Helsinki. Run it 23:00–08:00, or dump from a replica/snapshot.`

  if (
    SSH.test(cmd) && PROD.test(cmd) &&
    /\b(reboot|shutdown\s+-r|systemctl\s+reboot|qm\s+reboot|qm\s+reset|pct\s+reboot)\b/.test(cmd) &&
    !/OLIVIAOS_HARD_RESTART=1/.test(cmd)
  )
    return 'PROD UPTIME: reboot is the last resort. Try reload/graceful restart first. If the box is truly wedged, log why with ~/.oliviaos/scripts/log, then rerun with `OLIVIAOS_HARD_RESTART=1` in the command.'

  return undefined
}

const REMOTE_CHANGE =
  /\b(systemctl\s+(restart|reload|stop|start|enable|disable|daemon-reload)|docker(\s+compose|-compose)?\s+(up|down|restart|rm|stop|run|pull)|qm\s+(set|resize|start|stop|shutdown|create|destroy|migrate|snapshot|rollback)|pct\s+(set|start|stop|create|destroy|snapshot|rollback)|rm\s|mv\s|sed\s+-i|tee\s|apt(-get)?\s+(install|remove|purge|upgrade)|useradd|userdel|usermod|chmod|chown|crontab|ufw|iptables|nft\s|zfs\s+(create|destroy|snapshot|rollback|set)|kill\s)/
const LOCAL_CHANGE =
  /(^|[;&|]\s*)(git(\s+-C\s+\S+)?\s+push|rsync\s|scp\s|systemctl\s+(restart|reload|stop|start|enable|disable)|docker\s+compose\s+(up|down|restart)|qm\s|pct\s|wrangler\s+deploy|gh\s+pr\s+merge)/

/** True when a Bash command changes state somewhere that the decision log should know about. */
export function isStateChange(cmd: string): boolean {
  if (/\.oliviaos\/scripts\/log\b/.test(cmd)) return false // already logging itself
  if (SSH.test(cmd) && REMOTE_CHANGE.test(cmd)) return true
  return LOCAL_CHANGE.test(cmd)
}

/** Strips secrets before anything reaches the log. */
export function redact(s: string): string {
  return s
    .replace(/(authorization:\s*bearer\s+)\S+/gi, '$1[REDACTED]')
    .replace(/(bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1[REDACTED]')
    .replace(/\b([A-Z0-9_]*(TOKEN|SECRET|PASSWORD|PASSWD|PASS|KEY|APIKEY|API_KEY|AUTH)[A-Z0-9_]*)=("[^"]*"|'[^']*'|\S+)/gi, '$1=[REDACTED]')
    .replace(/([?&](token|key|secret|password|pass|auth|sig)=)[^&\s'"]+/gi, '$1[REDACTED]')
    .replace(/(-p|--password[= ])\S+/g, '$1[REDACTED]')
    .replace(/\b(ghp|gho|ghs|github_pat|sk|xox[abp]|glpat|cf)[-_][A-Za-z0-9_-]{10,}\b/g, '[REDACTED]')
    .replace(/:\/\/([^:/@\s]+):[^@\s]+@/g, '://$1:[REDACTED]@')
    .replace(/\b[a-f0-9]{32,}\b/gi, '[REDACTED-HEX]')
    .replace(/[A-Za-z0-9+_-]{32,}={0,2}/g, t => (/[0-9]/.test(t) && /[A-Z]/.test(t) && /[a-z]/.test(t) ? '[REDACTED-KEY]' : t))
}

export function withCarry(prompt: string): string {
  return /RULES\.md|OliviaOS Rule/.test(prompt) ? prompt : `${prompt}\n\n${CARRY}`
}


// ---------- night + autonomy ----------

export const AUTONOMY =
  'OliviaOS autonomy (enforced by the oliviaos-guard mod): think for yourself and act. ' +
  'Decide by reversibility × reach. Reversible → do it, report after. Irreversible → first make it reversible ' +
  '(backup to ~/.oliviaos/backups, snapshot, second way in), then do it. Only irreversible + Live (real people, money, ' +
  'production data, auth) with no possible backup is a question for Olivia. "It is risky" is not a reason to ask. ' +
  'Never end with "want me to…?" / "should I…?" for reversible work: just do it. A pending question never idles you: ' +
  'use ask_olivia with a default_action and carry on. To ask anyway, start the question with "IRREVERSIBLE+LIVE:" ' +
  'and say why no backup or fallback is possible. ' +
  'When a decision matters (real alternatives, a wrong pick is costly or hard to undo: architecture, data model, auth, ' +
  'an irreversible step, changing her plan), consult a stronger model first: the advisor tool if present, else an ' +
  'Agent with model "opus" and a short brief (decision, options, constraints). Not for trivial choices. Then decide ' +
  'yourself. When Olivia corrects you, rejects something or approves something non-obvious, record it as a preference ' +
  '(what · why · how to apply) in ~/.oliviaos/preferences.md (general) or project memory (project-specific). When a ' +
  'known preference covers a choice, act on it and say so ("doing X, you\'ve preferred X before"); do not ask. Her ' +
  'explicit answers (my_answers) and current instructions always win over a prediction.'

export const NIGHT =
  'It is night in Helsinki (23:00–08:00). Olivia is asleep and must not be woken or asked for approval ' +
  '(tired = yes to everything = no real check). AskUserQuestion, PushNotification and blocking ask_olivia are ' +
  'refused until 08:00. Decide everything yourself by the OliviaOS Rule. For irreversible + Live work do only ' +
  'immediate reversible containment (stop, pause, roll back) and hold the real decision for the ~10:00 report: ' +
  'put it in report_work and a non-blocking ask_olivia with your default_action. Rather the site down overnight ' +
  'than Olivia woken.'

const ASKS_PERMISSION =
  /\b(should i|shall i|want me to|ok to|okay to|can i go ahead|go ahead and|ok if i|is it ok|mind if i|would you like me to|do you want me to|shall we|should we)\b/i
const LABEL = /IRREVERSIBLE\+LIVE/
// "Rewrite the history?" asks permission without any of the phrases above; yes / no answers give it away.
// Short words must be the whole answer ("No framework" and the language "Go" are real choices).
const YES = /^\s*(yes\b|(ok|okay|sure|do it|go ahead|approve|confirm|kyllä|joo)(\s*$|[,.!]))/i
const NO = /^\s*((no|nope|ei|skip|later|cancel)(\s*$|[,.!])|(not now|not yet|keep (it|them|both)|leave (it|them))\b)/i
// Acts that need her own yes whatever the rules say: leave those questions alone.
const NEEDS_HER = /\b(send|pay|buy|purchase|sign up|accept (the )?terms|permanently delete)\b/i

/** True when a question with these answer buttons is a request for permission. */
export function isPermissionAsk(question: string, answers: string[] = []): boolean {
  if (LABEL.test(question) || NEEDS_HER.test(question)) return false
  return ASKS_PERMISSION.test(question) || answers.some(a => YES.test(a) || NO.test(a))
}

/** Deny reason for the app's next-step box (wrap_up ask), or undefined. */
export function boxVerdict(ask: unknown, actions: unknown): string | undefined {
  if (typeof ask !== 'string' || !ask) return undefined
  // App actions (commit, create_pr, ...) are the app's own buttons, not a question's answers.
  const answers = (Array.isArray(actions) ? actions : []).filter((a: any) => !a?.action).map((a: any) => String(a?.label ?? ''))
  if (!isPermissionAsk(ask, answers)) return undefined
  return 'AUTONOMY: this next-step box asks Olivia for permission. Under the OliviaOS Rule reversible work is not a question: back up, do it now, then call wrap_up with only a recap. If it is irreversible + Live with no backup or fallback possible, start the ask with "IRREVERSIBLE+LIVE:" and say why. Do not move the question into your closing text instead.'
}

/** Deny reason for a question to Olivia, or undefined to let it through. */
export function questionVerdict(texts: string[], night: boolean, awake = false): string | undefined {
  const all = texts.join(' \n ')
  const asks = ASKS_PERMISSION.test(all) || LABEL.test(all)
  // At night a factual question while Olivia is chatting wakes nobody; approvals still wait (tired = yes).
  if (night && !(awake && !asks))
    return 'NIGHT GUARD: Olivia is asleep (23:00–08:00 Helsinki). Do not ask her. Decide yourself by the OliviaOS Rule: reversible → do it; irreversible + Live → only containment (stop, pause, roll back) and hold it for the ~10:00 report via report_work and a non-blocking ask_olivia with a default_action.'
  if (!night && ASKS_PERMISSION.test(all) && !LABEL.test(all))
    return 'AUTONOMY: this asks Olivia for permission. Under the OliviaOS Rule you decide reversible work yourself: do it and report after. If it truly is irreversible + Live with no backup or fallback possible, ask again with the question starting "IRREVERSIBLE+LIVE:" and why no backup is possible. Otherwise use ask_olivia with a default_action and carry on.'
  return undefined
}


// ---------- model tiering ----------

export type Tier = 'haiku' | 'sonnet' | 'opus'

const READ_ONLY_AGENTS = /^(Explore|web-fetch|claude-code-guide|statusline-setup)$/
const READ_ONLY =
  /\b(search|find|look up|lookup|locate|grep|read|list|summari[sz]e|summary|status|check (if|whether|the)|watch|monitor|fetch|scan|inspect|count|what (is|are)|where (is|are)|which)\b/i
const WRITES =
  /\b(fix|implement|build|write|edit|change|update|add|create|refactor|migrate|deploy|install|delete|remove|rename|merge|rebase|commit|push|test|debug)\b/i
const OPUS_WORK =
  /\b(architect|architecture|design (the|a|an)|plan(ning)? (the|a|an)|security|auth(entication|orization)?|permissions?|privilege|threat model|hard (bug|debug)|root cause|final (call|judg(e)?ment|review))\b/i

// A decision consult: the brief asks a stronger model to help choose. It gets Opus explicitly, not the session's model.
const CONSULT =
  /\b(brainstorm|advise|advice|best way|which approach|trade-?offs?|decide between|pros and cons|second opinion|recommend(ation)?)\b/i

/** True when the brief asks for a decision consult (OliviaOS: brainstorm with a stronger model). */
export const isConsult = (prompt: string) => CONSULT.test(prompt)

/** The cheapest model that fits the brief (OliviaOS model tiering). */
export function pickTier(prompt: string, agentType = ''): Tier {
  if (READ_ONLY_AGENTS.test(agentType)) return 'haiku'
  if (OPUS_WORK.test(prompt) || CONSULT.test(prompt)) return 'opus'
  if (READ_ONLY.test(prompt) && !WRITES.test(prompt)) return 'haiku'
  return 'sonnet'
}

const SESSION_MODEL: Record<Tier, string> = {
  haiku: 'claude-haiku-5-5',
  sonnet: 'claude-sonnet-5-5',
  opus: 'claude-opus-5-5',
}

/** Adds a model to an Agent or start_session call that has none; never overrides one that is set. */
export function withTier(e: any): any {
  if (typeof e.prompt !== 'string' || e.prompt.length === 0) return e
  if (e.tool === 'Agent') {
    if (e.model || e.subagent_type === 'fork') return e
    const text = `${e.description ?? ''} ${e.prompt}`
    if (isConsult(text) && !READ_ONLY_AGENTS.test(e.subagent_type ?? '')) return { ...e, model: 'opus' }
    const t = pickTier(text, e.subagent_type ?? '')
    return t === 'opus' ? e : { ...e, model: t }
  }
  if (e.tool === 'mcp__ccd_session__start_session') {
    if (e.model || e.context === 'fork' || e.target === 'cloud' || e.proposal_id) return e
    const text = `${e.title ?? ''} ${e.prompt}`
    if (isConsult(text)) return { ...e, model: SESSION_MODEL.opus }
    const t = pickTier(text)
    return t === 'opus' ? e : { ...e, model: SESSION_MODEL[t] }
  }
  return e
}

/** One quiet line for the end of a reply, or '' when the guard did nothing this turn. */
export function turnSummary(nLogged: number, nBlocked: number): string {
  const parts: string[] = []
  if (nLogged > 0) parts.push(`${nLogged} logged`)
  if (nBlocked > 0) parts.push(`${nBlocked} blocked`)
  return parts.length ? `— OliviaOS guard: ${parts.join(' · ')} this turn (decisions.md + OliviaOS inbox)` : ''
}

// ---------- infra map first ----------

export const INFRA_REMINDER =
  'OliviaOS: this prompt is about infrastructure and the live infra map has not been loaded in this session. ' +
  'Before answering or acting, call infra_get (and infra_observed for live facts); never answer infra questions ' +
  'from memory or old notes. If the map and reality disagree, say so and fix the map with infra_upsert.'

// Generic words only: this repository is public. Her other host names are learned from the map itself.
const INFRA_WORDS =
  /\b(servers?|vms?|containers?|back-?ups?|domains?|dns|ssh|deploy(?:s|ed|ments?|ing)?|vps|homelab|proxmox|moso-prod|lc-(?:main|db|email)|ax41|os-mcp|infra(?:structure)?)\b|palveli[mn]|varmuuskopi|verkkotunnu/i

/** True when the text is about infrastructure: a generic word, or a host name or alias from the map. */
export function mentionsInfra(text: string, names: string[] = []): boolean {
  if (INFRA_WORDS.test(text)) return true
  return names.some(n => new RegExp(`(?<![\\w.-])${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])`, 'i').test(text))
}

/** Host-like ids and aliases (with a digit, dot or hyphen) from an infra_get result. */
export function hostNames(result: string): string[] {
  try {
    const nodes: any[] = JSON.parse(result).nodes ?? []
    const all = nodes
      .filter(n => !['people', 'saas', 'edge'].includes(n?.kind))
      .flatMap(n => [n?.id, ...(Array.isArray(n?.aliases) ? n.aliases : [])])
    return [...new Set(all.filter((s): s is string => typeof s === 'string' && s.length >= 4 && /[0-9.-]/.test(s) && !/[\s@]/.test(s)).map(s => s.toLowerCase()))]
  } catch {
    return []
  }
}

const INFRA_GET = /^mcp__.+__infra_get$/

// ---------- caveman voice ----------

// Condensed from the caveman skill (github.com/JuliusBrussee/caveman), so sessions without the skill get it too.
export const CAVEMAN =
  'OliviaOS voice (enforced by the oliviaos-guard mod): use caveman everywhere you talk: chat replies, status lines ' +
  'and recaps, report_work and ask_olivia entries, messages to other agents or sessions, subagent and session briefs ' +
  'and their reports. Answer first, then reason, then next step. No greetings, hedging, filler, recaps or closers. ' +
  'Short words. Articles optional, but never drop not, never, no, only or except. One idea per sentence. Keep code, ' +
  "commands, paths, numbers and quoted errors exact. Use the user's language. Write normal full sentences for: " +
  'security warnings; irreversible steps; step order that could be misread; questions to the user; anything saved or ' +
  'sent outside chat (code, comments, commits, docs, PRs, issues, memory files, and every message to other people, ' +
  'such as email or job applications). Off only when Olivia says "stop caveman" or "normal mode"; "/caveman" turns it ' +
  'back on.'

export const CAVEMAN_REMINDER = 'Caveman voice (OliviaOS): terse, answer first, every fact kept. Full sentences only where the voice rule says so.'

/** Her own words that switch the voice: false = off, true = on, undefined = no switch. */
export function caveSwitch(text: string): boolean | undefined {
  const t = text.trim()
  if (/^(ok(ay)?[, ]+|please )?(stop caveman|normal mode)\b.{0,30}$/i.test(t)) return false
  if (/^(\/caveman(:caveman)?|caveman mode|talk like caveman)\b.{0,30}$/i.test(t)) return !/\b(off|status)\b/i.test(t) ? true : /\boff\b/i.test(t) ? false : undefined
  return undefined
}

// Only she may switch it: not another session, a task notice or a plugin.
const HERS = ['composer', 'bridge', 'sdk', 'projects-relay']

// ---------- preferences ----------

export const PREFS_REMINDER =
  'OliviaOS: this looks like a correction or a preference from Olivia. If it is durable (not just for this task), ' +
  'record it: what she wants · why · how to apply, in ~/.oliviaos/preferences.md (general) or project memory ' +
  '(project-specific). Update an existing entry instead of adding a duplicate.'

// Her words that usually carry a correction or a standing preference. Reminder only.
const CORRECTION =
  /(^\s*(no|nope|ei|not like that|wrong)\b[,.!]?)|\b(don'?t|do not|never|always|stop doing|i prefer|i'd rather|i would rather|prefer(ably)?|instead of|from now on|next time|i (don'?t|do not) (like|want)|that'?s not what)\b|(?<!\p{L})(älä|älkää|aina|ei koskaan|mieluummin|jatkossa|ensi kerralla|en halua)(?!\p{L})/iu

/** True when her prompt looks like a correction or a standing preference. */
export const looksLikeFeedback = (text: string) => text.length < 4000 && CORRECTION.test(text)

const PREFS_MAX = 4000

/** The system-prompt section for ~/.oliviaos/preferences.md, capped; '' when the file is missing or empty. */
export function prefsSection(text: string): string {
  const t = text.trim()
  if (!t) return ''
  const body = t.length > PREFS_MAX ? `${t.slice(0, PREFS_MAX)}\n\n[…cut; read the full file ~/.oliviaos/preferences.md]` : t
  return `# Olivia's preferences (from ~/.oliviaos/preferences.md, loaded by oliviaos-guard)\n\n` +
    'Act on these and say so in one line; do not ask again. Her explicit answers (my_answers) and current ' +
    `instructions win over anything here.\n\n${body}`
}

async function loadPrefs($: EngineInterface): Promise<string> {
  try {
    const home = (await $.env.get('HOME')) ?? ''
    return prefsSection(await $.fs.read(`${home}/.oliviaos/preferences.md`))
  } catch {
    return ''
  }
}

// ---------- hooks ----------

let cwd = ''
let lastPromptAt = 0
let turnLogged = 0
let turnBlocked = 0
let infraTurn = false
let liveRules = ''
let rulesFromMcp = false
let rulesTriedAt = 0
const AWAKE_MS = 20 * 60 * 1000
const awakeNow = () => Date.now() - lastPromptAt < AWAKE_MS

/** Live rules: OliviaOS rules_get first, then ~/.oliviaos/RULES.md. */
async function loadRules($: EngineInterface): Promise<string> {
  rulesTriedAt = Date.now()
  for (const name of await serversWith($, 'rules_get')) {
    try {
      // connect() waits for a server that is still starting, so the first prompt gets the live rules.
      const c: any = await $.mcp.connect(name)
      const server = c?.server ?? name
      const res = await $.mcp.call(server, 'rules_get', {})
      if (!res.isError) {
        const text = res.content.map((c: any) => (c.type === 'text' ? c.text : '')).join('')
        let rules = text
        try { rules = JSON.parse(text).rules ?? text } catch {}
        if (rules.length > 200) { rulesFromMcp = true; return rules }
      }
    } catch {}
  }
  try {
    const home = (await $.env.get('HOME')) ?? ''
    return await $.fs.read(`${home}/.oliviaos/RULES.md`)
  } catch {}
  return ''
}

/** Writes one entry to decisions.md and queues it for OliviaOS. */
async function record($: EngineInterface, r: { title: string; what: string; cls: string; revert: string; summary: string }) {
  try {
    const home = (await $.env.get('HOME')) ?? ''
    await $.process.run([`${home}/.oliviaos/scripts/log`, r.title, r.cls, '', r.revert], { timeoutMs: 5000 })
  } catch {}
  const project = cwd.split('/').filter(Boolean).pop() ?? ''
  await update($, pending, q => [...q, { title: r.title.slice(0, 200), summary: r.summary, what: r.what, project, cls: r.cls, revert: r.revert }])
  try { await flush($) } catch {}
}

async function refuse($: EngineInterface, why: string, what: string) {
  await update($, blocked, n => n + 1)
  turnBlocked += 1
  const w = redact(what).replace(/\s+/g, ' ').slice(0, 300)
  await record($, {
    title: `[blocked] ${w}`,
    what: w,
    cls: 'blocked',
    revert: 'nothing ran',
    summary: `oliviaos-guard blocked this (secrets redacted). Nothing ran.\n\nWhat: ${w}\n\nWhy: ${why}`,
  })
  await refresh($)
  $.ui.toast(`OliviaOS guard blocked: ${w.slice(0, 80)}`)
  return { deny: `oliviaos-guard: ${why}` }
}

async function refresh($: EngineInterface) {
  const n = await read($, logged)
  const b = await read($, blocked)
  const s = await read($, sent)
  const q = (await read($, pending)).length
  const night = isNight(helsinkiHour()) ? ' · night' : ''
  const queued = q > 0 ? ` (${q} queued)` : ''
  const t = await read($, tieredCount)
  const cheap = t > 0 ? ` · ${t} on cheaper model` : ''
  $.ui.status(`OliviaOS guard · ${n} logged · ${s} sent${queued} · ${b} blocked${cheap}${night}`)
}

export function reportArgs(r: Report) {
  return {
    title: r.title,
    summary: r.summary,
    decisions: [{ what: r.what, class: r.cls ?? 'auto-logged', revert: r.revert ?? 'see command; the agent adds a proper entry if this mattered' }],
    session: 'oliviaos-guard',
    place: 'mac',
    project: r.project,
  }
}

// The OliviaOS MCP server's name depends on how it was added: the plugin, claude.ai connector, or a plain entry.
const SERVERS = ['plugin:oliviaos:oliviaos', 'claude.ai oliviaos', 'oliviaos']

/** Every connected server that has the tool, by the tool list (mcp__<server>__<tool>), then the known names. */
async function serversWith($: EngineInterface, tool: string): Promise<string[]> {
  const found: string[] = []
  try {
    for (const t of await $.tool.list()) {
      const m = /^mcp__(.+)__([^_].*)$/.exec(t.name)
      if (m && m[2] === tool && m[1]) found.push(m[1])
    }
  } catch {}
  return [...new Set([...found, ...SERVERS])]
}

/** Sends every queued report to OliviaOS; keeps the ones that fail. */
async function flush($: EngineInterface) {
  const queue = await read($, pending)
  const left: Report[] = []
  for (const r of queue) {
    let ok = false
    for (const server of await serversWith($, 'report_work')) {
      try {
        const res = await $.mcp.call(server, 'report_work', reportArgs(r))
        if (!res.isError) { ok = true; break }
        $.ui.log(`oliviaos-guard: report_work via ${server} failed: ${JSON.stringify(res.content).slice(0, 300)}`, { to: 'debug' })
      } catch (err) {
        $.ui.log(`oliviaos-guard: report_work via ${server} threw: ${String(err).slice(0, 300)}`, { to: 'debug' })
      }
    }
    if (ok) { await update($, sent, n => n + 1); $.ui.log('oliviaos-guard: report_work sent', { to: 'debug' }) }
    else left.push(r)
  }
  await update($, pending, () => left.slice(-200))
}

export const register: Register = on => {
  on('prompt.submit', async ($, e, next) => {
    lastPromptAt = Date.now()
    turnLogged = 0
    turnBlocked = 0
    const origin = (e as any).origin?.kind
    const hers = !e.isMeta && (origin === undefined || HERS.includes(origin))
    if (hers) {
      const to = caveSwitch(e.text)
      if (to !== undefined) await update($, caveman, () => to)
    }
    const add: string[] = []
    if (hers && !e.command && looksLikeFeedback(e.text)) add.push(PREFS_REMINDER)
    // No network here: the names come from the plugin's own store.
    if (!e.isMeta && !e.command) {
      if (await read($, caveman)) add.push(CAVEMAN_REMINDER)
      const names = ((await $.store.get('infraNames')) as string[] | undefined) ?? []
      if (mentionsInfra(e.text, names)) {
        infraTurn = true
        if (!(await read($, mapLoaded))) add.push(INFRA_REMINDER)
      }
    }
    return next(add.length ? { ...e, context: [...(e.context ?? []), ...add] } : e)
  }).catch(($, e, next) => next(e))

  on('session.start', async ($, e, next) => {
    cwd = e.cwd ?? ''
    const started = await next(e)
    await refresh($)
    void loadRules($).then(r => { liveRules = r }).catch(() => {})
    return started
  })

  // 1 + 2: Bash guard and auto-log.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const cmd = e.command
    const stop = hardStop(cmd, helsinkiHour())
    if (stop) return refuse($, stop, cmd)

    const ran = await next(e)
    if (ran.deny === undefined && ran.isError !== true && isStateChange(cmd)) {
      try {
        const what = redact(e.description ? `${e.description}: ${cmd}` : cmd).replace(/\s+/g, ' ').slice(0, 300)
        await update($, logged, n => n + 1)
        turnLogged += 1
        // A server action says whether the map was loaded first.
        const map = SSH.test(cmd) ? ` (infra map loaded first: ${(await read($, mapLoaded)) ? 'yes' : 'no'})` : ''
        await record($, {
          title: `[auto] ${what}`,
          what: `${what}${map}`,
          cls: 'auto-logged',
          revert: 'see command; the agent adds a proper entry if this mattered',
          summary: `oliviaos-guard auto-logged a state-changing command that succeeded (secrets redacted). Also in ~/.oliviaos/decisions.md.\n\n${what}${map}`,
        })
        await refresh($)
      } catch {
        // Never break a tool call over logging.
      }
    }
    return ran
  }).catch(($, e, next) => (next.called ? next(e) : { deny: 'oliviaos-guard: its guard failed; retry the command.' }))

  // 3: carry the rule into subagent and session briefs.
  on('tool.call', async ($, e: any, next) => {
    if (typeof e.tool === 'string' && INFRA_GET.test(e.tool)) {
      const ran: any = await next(e)
      if (ran.deny === undefined && ran.isError !== true) {
        try {
          await update($, mapLoaded, () => true)
          const found = hostNames(ran.text ?? '')
          if (found.length) {
            const known = ((await $.store.get('infraNames')) as string[] | undefined) ?? []
            await $.store.set('infraNames', [...new Set([...known, ...found])].slice(-300))
          }
        } catch {
          // Never break a tool call over the reminder.
        }
      }
      return ran
    }
    if (e.tool === 'mcp__ccd_turn__wrap_up') {
      const why = boxVerdict(e.ask, e.actions)
      return why ? refuse($, why, `wrap_up ask: ${e.ask}`) : next(e)
    }
    const isBrief = e.tool === 'Agent' || e.tool === 'mcp__ccd_session__start_session'
    if (typeof e.tool === 'string' && /oliviaos.*__ask_olivia$/.test(e.tool) && e.blocking === true) {
      const why = questionVerdict([String(e.question ?? '')], isNight(helsinkiHour()))
      if (why) {
        if (!e.default_action) return refuse($, `${why} Re-send ask_olivia with blocking false and a default_action.`, `ask_olivia (blocking): ${e.question ?? ''}`)
        return next({ ...e, blocking: false })
      }
    }
    if (isBrief && typeof e.prompt === 'string' && e.prompt.length > 0) {
      const tiered = withTier(e)
      if (tiered.model !== e.model) await update($, tieredCount, n => n + 1)
      return next({ ...tiered, prompt: withCarry(e.prompt) })
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  // 5: autonomy always, night rules 23–08 Helsinki, in the system prompt.
  on('prompt.compose', async ($, e, next) => {
    if (!rulesFromMcp) {
      const t = await loadRules($)
      if (t) liveRules = t
    }
    const r = await next(e)
    // The MCP server often connects after session.start: retry for the live rules, at most every 10 s.
    if (!rulesFromMcp && Date.now() - rulesTriedAt > 10_000) void loadRules($).then(t => { if (t) liveRules = t }).catch(() => {})
    const extra = [{ id: 'oliviaos-guard:autonomy', text: AUTONOMY, scope: 'session' as const }]
    if (liveRules) extra.push({ id: 'oliviaos-guard:rules', text: `# OliviaOS rules (live, from the OliviaOS skill's rules_get)\n\n${liveRules}`, scope: 'session' as const })
    const prefs = await loadPrefs($)
    if (prefs) extra.push({ id: 'oliviaos-guard:preferences', text: prefs, scope: 'session' as const })
    if (await read($, caveman)) extra.push({ id: 'oliviaos-guard:caveman', text: CAVEMAN, scope: 'session' as const })
    if (isNight(helsinkiHour())) extra.push({ id: 'oliviaos-guard:night', text: awakeNow() ? `${NIGHT} Olivia is chatting right now, so a plain factual question is fine; approvals still wait for the morning.` : NIGHT, scope: 'session' as const })
    return { ...r, sections: [...r.sections, ...extra] }
  }).catch(($, e, next) => next(e))

  // 6: questions, pings and wake-ups.
  on('tool.call', { tool: 'AskUserQuestion' }, async ($, e, next) => {
    const texts = (e.questions ?? []).map(q => q.question ?? '')
    const night = isNight(helsinkiHour())
    const yesNo = (e.questions ?? []).some(q => isPermissionAsk(q.question ?? '', (q.options ?? []).map(o => o.label ?? '')))
    const why = questionVerdict(texts, night, awakeNow()) ??
      (!night && yesNo && !texts.some(t => LABEL.test(t)) ? 'AUTONOMY: a yes / no question about reversible work is a permission request. Back up, do it, and report after. If irreversible + Live with no backup possible, start the question with "IRREVERSIBLE+LIVE:".' : undefined)
    return why ? refuse($, why, `AskUserQuestion: ${texts.join(' | ')}`) : next(e)
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'PushNotification' }, async ($, e, next) =>
    isNight(helsinkiHour()) && !awakeNow()
      ? refuse($, 'NIGHT GUARD: no phone notifications 23:00–08:00 Helsinki. Put it in report_work for the ~10:00 report. Contain the problem yourself (stop, pause, roll back).', `PushNotification: ${e.message ?? ''}`)
      : next(e),
  ).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'SendUserFile' }, async ($, e, next) =>
    isNight(helsinkiHour()) && !awakeNow() && e.status === 'proactive' ? next({ ...e, status: 'normal' }) : next(e),
  ).catch(($, e, next) => next(e))


  // 7: plain-text fallback. Project and cloud threads draw no status line, so a turn
  // in which the guard logged or blocked something ends with one line saying so.
  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    const line = turnSummary(turnLogged, turnBlocked)
    turnLogged = 0
    turnBlocked = 0
    // Once per session and outcome: was the map loaded before an infra answer? The prompt itself is never recorded.
    if (infraTurn) {
      infraTurn = false
      try {
        const loaded = await read($, mapLoaded)
        const key = loaded ? 'loaded' : 'missing'
        if (!(await read($, mapNoted)).includes(key)) {
          await update($, mapNoted, a => [...a, key])
          const title = loaded
            ? '[infra-check] infra map was loaded before an infra answer'
            : '[infra-check] infra answer without loading the infra map'
          await record($, { title, what: title, cls: 'infra-check', revert: 'nothing to revert', summary: `${title}. Recorded once per session; the prompt is not included.` })
        }
      } catch {}
    }
    return line && typeof r.text === 'string' ? { ...r, text: `${r.text}\n\n${line}` } : r
  }).catch(($, e, next) => next(e))
}

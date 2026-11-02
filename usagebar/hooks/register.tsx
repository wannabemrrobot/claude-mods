import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionUsage, Timer } from 'claude-code'

import {
  EMPTY_CTX,
  EMPTY_SESSION,
  ZERO,
  addUsage,
  contextOf,
  ctxLine,
  limitsLine,
  FRAME_MS,
  hasShimmer,
  modelParts,
  padRow,
  parseEffortCommand,
  partsWidth,
  pushHistory,
  sanitizeTokens,
  settingsEffort,
  shimmerFrames,
  shownModel,
  strWidth,
  toLimits,
} from './lib'
import type { BarModel, Part, ShimmerFrames } from './lib'
import { CAP_HELP, NO_CAPS, capDeny, capNote, capsFrom, describeCaps, parseCapCommand, worstStage } from './cap'
import type { CapReading, Caps } from './cap'
import type { BarLimit } from '../types'

type Engine = EngineInterface

const TOKENS = { plugin: 'usagebar', key: 'tokens' } as const
const CTX = { plugin: 'usagebar', key: 'ctx' } as const
const LIMITS = { plugin: 'usagebar', key: 'limits' } as const
const SESSION = { plugin: 'usagebar', key: 'session' } as const
const SEEN = { plugin: 'usagebar', key: 'seen' } as const
const ULTRACODE = { plugin: 'usagebar', key: 'ultracode' } as const

const tokensA = atom(TOKENS, ZERO)
const ctxA = atom(CTX, EMPTY_CTX)
const limitsA = atom(LIMITS, [])
const sessionA = atom(SESSION, EMPTY_SESSION)
const seenA = atom(SEEN, null)
const ultracodeA = atom(ULTRACODE, null)

/** Redraws are cheap; the reset countdowns read to the minute. */
const TICK_MS = 30_000
/** Sessions whose counts the store keeps, newest last. */
const KEEP_SESSIONS = 20

// Module state: a hot reload starts these over; $.state keeps the rest.
let sessionIdCache: string | null = null
let ticker: Timer | null = null
let homeCache: string | null = null
/** Cells the engine's mode labels take at the footer's right end, as SessionMode last drew them. */
let modesWidth = 0

// ------------------------------------------------------------ the usage cap
// Kept in plain variables, so the check on each tool call reads no state:
// the limits as the last reading left them and the caps as last loaded.

const CAP_SETTINGS = 'cap:settings'
const CAP_OVERRIDE = 'cap:override'
let pluginOptions: Readonly<Record<string, unknown>> = {}
let capsCache: Caps = NO_CAPS
let limitsCache: readonly BarLimit[] = []
/** `/usagecap override`: past the cap until this time (the window's reset); null: no override. */
let overrideUntil: number | null = null
/** The last note each loop (main, or a subagent's id) was given, so each stage is said once. */
const notesSent = new Map<string, string>()
let toastedFor: string | null = null

const hasCaps = (c: Caps) => c.fiveHour !== null || c.week !== null
const isOverridden = (now: number) => overrideUntil !== null && now < overrideUntil

async function loadCaps($: Engine) {
  const [saved, override] = await Promise.all([$.store.get(CAP_SETTINGS), $.store.get(CAP_OVERRIDE)])
  capsCache = capsFrom(pluginOptions, saved)
  overrideUntil = typeof override === 'number' && Number.isFinite(override) ? override : null
}

async function capReading($: Engine): Promise<{ r: CapReading | null; now: number }> {
  if (!hasCaps(capsCache) || limitsCache.length === 0) return { r: null, now: 0 }
  const now = await $.clock.now()
  return { r: worstStage(limitsCache, capsCache, now), now }
}

/** The note a loop should read now, or null when it already has it. */
function noteOnce(loop: string, r: CapReading, over: boolean): string | null {
  const key = `${r.kind}|${r.resetsAt}|${r.stage}|${over}|${capsCache.mode}`
  if (notesSent.get(loop) === key) return null
  notesSent.delete(loop)
  notesSent.set(loop, key)
  while (notesSent.size > 64) notesSent.delete(notesSent.keys().next().value as string)
  return capNote(r, capsCache.mode, over)
}

/** One toast when a window first reaches its cap. */
async function toastAtCap($: Engine) {
  const { r, now } = await capReading($)
  if (!r || r.stage !== 'cap') return
  const key = `${r.kind}|${r.resetsAt}`
  if (toastedFor === key) return
  toastedFor = key
  const name = r.kind === 'five_hour' ? '5h' : 'weekly'
  const tail = isOverridden(now) ? 'override on' : capsCache.mode === 'warn-only' ? 'the agent was told to stop' : 'tool calls paused; /usagecap override to continue'
  $.ui.toast(`usagebar: ${name} usage ${r.percent}% hit your ${r.cap}% cap: ${tail}`)
}

async function runCapCommand($: Engine, args: string): Promise<string> {
  const cmd = parseCapCommand(args)
  const saved = async () => {
    const raw = await $.store.get(CAP_SETTINGS)
    return raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
  }
  switch (cmd.kind) {
    case 'show':
      break
    case 'help':
      return cmd.error ? `${cmd.error}\n\n${CAP_HELP}` : CAP_HELP
    case 'set':
      await $.store.set(CAP_SETTINGS, { ...(await saved()), ...cmd.patch })
      break
    case 'off':
      await $.store.set(CAP_SETTINGS, { ...(await saved()), cap5h: null, capWeek: null })
      break
    case 'reset':
      await $.store.delete(CAP_SETTINGS)
      await $.store.delete(CAP_OVERRIDE)
      break
    case 'override': {
      const { r, now } = await capReading($)
      if (!r || r.stage !== 'cap') return `Nothing to override: no window is at its cap. ${describeCaps(capsCache)}`
      // Until the window resets; with no reset reported, for the next 5 hours.
      const until = r.resetsAt ?? now + 5 * 3_600_000
      await $.store.set(CAP_OVERRIDE, until)
      await loadCaps($)
      $.ui.invalidate('ui.render')
      return `Override on: tool calls go through past the cap until the window resets. ${describeCaps(capsCache)}`
    }
  }
  await loadCaps($)
  notesSent.clear()
  toastedFor = null
  $.ui.invalidate('ui.render')
  const over = overrideUntil !== null && overrideUntil > (await $.clock.now()) ? ' · override on' : ''
  return describeCaps(capsCache) + over
}

const debug = ($: Engine, text: string) => {
  try {
    $.ui.log(`usagebar: ${text}`, { to: 'debug' })
  } catch {
    // nothing to tell it to
  }
}

async function safe<T>($: Engine, what: string, fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn()
  } catch (err) {
    debug($, `${what} failed: ${err instanceof Error ? err.message : String(err)}`)
    return undefined
  }
}

async function sessionId($: Engine) {
  sessionIdCache ??= await $.session.id()
  return sessionIdCache
}

async function persistTokens($: Engine) {
  const tokens = await read($, tokensA)
  if (tokens.requests === 0) return
  const id = await sessionId($)
  await $.store.set(`tokens:${id}`, tokens)
  const raw = await $.store.get('tokens:index')
  const index = Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : []
  if (index.at(-1) === id) return
  const next = [...index.filter(x => x !== id), id]
  for (const old of next.slice(0, Math.max(0, next.length - KEEP_SESSIONS))) await $.store.delete(`tokens:${old}`)
  await $.store.set('tokens:index', next.slice(-KEEP_SESSIONS))
}

async function takeUsage($: Engine, u: Pick<SessionUsage, 'context' | 'rateLimits' | 'cost'>) {
  await update($, ctxA, c => ({ ...c, tokens: u.context.tokens ?? c.tokens, window: u.context.window }))
  const limits = toLimits(u.rateLimits)
  limitsCache = limits
  await update($, limitsA, () => limits)
  const cost = u.cost
  if (cost) await update($, sessionA, () => ({ costUsd: cost.usd }))
}

async function refresh($: Engine, withBreakdown: boolean) {
  const u = await $.session.usage(withBreakdown ? { breakdown: 'summary' } : undefined)
  await takeUsage($, u)
  const b = u.context.breakdown
  if (b) {
    await update($, ctxA, c => ({
      ...c,
      threshold: b.isAutoCompactEnabled ? (b.autoCompactThreshold ?? null) : null,
      isAutoCompact: b.isAutoCompactEnabled,
      estimate: b.totalTokens,
    }))
  }
}

/** Claude's config folder: CLAUDE_CONFIG_DIR when set, else ~/.claude. */
async function claudeHome($: Engine) {
  if (homeCache !== null) return homeCache
  const dir = await $.env.get('CLAUDE_CONFIG_DIR')
  const home = await $.env.get('HOME')
  const raw = dir || (home ? `${home}/.claude` : '')
  homeCache = raw.length > 1 ? raw.replace(/\/+$/, '') : raw
  return homeCache
}

type SettingsSnapshot = {
  effortFor: (model: string) => string | null
  /** `/effort ultracode on`, as the settings carry it. */
  isUltracode: boolean
  /** Claude Code's own reduced-motion setting: no shimmer while it is on. */
  isReducedMotion: boolean
  at: number
}

/** How long a settings read is reused: the footer redraws often, the settings rarely change. */
const SETTINGS_TTL_MS = 2000
let settingsCache: SettingsSnapshot | null = null

/** The settings the model line reads, from one snapshot reused for SETTINGS_TTL_MS; `fresh` reads again. */
async function readSettings($: Engine, fresh = false): Promise<SettingsSnapshot> {
  const now = await $.clock.now()
  if (!fresh && settingsCache && now - settingsCache.at < SETTINGS_TTL_MS) return settingsCache
  const [modelSettings, effortLevel, ultracode, reducedMotion] = await Promise.all([
    $.settings.read({ key: 'modelSettings' }),
    $.settings.read({ key: 'effortLevel' }),
    $.settings.read({ key: 'ultracode' }),
    $.settings.read({ key: 'prefersReducedMotion' }),
  ])
  settingsCache = {
    effortFor: model => settingsEffort(modelSettings, effortLevel, model),
    isUltracode: ultracode === true,
    isReducedMotion: reducedMotion === true,
    at: now,
  }
  return settingsCache
}

/** Reads the settings' effort for each model asked, from one snapshot. */
async function settingsReader($: Engine, fresh = false) {
  return (await readSettings($, fresh)).effortFor
}

function later($: Engine, ms: number, what: string, fn: () => Promise<unknown>) {
  $.clock.after(ms, () => void safe($, what, fn))
}

async function readModel($: Engine): Promise<BarModel> {
  const [tokens, ctx, limits, session, now, cwd, home] = await Promise.all([
    read($, tokensA),
    read($, ctxA),
    read($, limitsA),
    read($, sessionA),
    $.clock.now(),
    // Read per draw, so a directory change shows on the next redraw.
    safe($, 'reading the cwd', () => $.session.cwd()),
    safe($, 'reading the config folder', () => claudeHome($)),
  ])
  return {
    tokens,
    ctx,
    limits,
    session,
    now,
    cwd: cwd ?? null,
    home: home || null,
    ...(hasCaps(capsCache) ? { caps: capsCache, isOverridden: isOverridden(now) } : {}),
  }
}

/** The model and effort as the last main request ran them, read again per draw against /model and /effort. */
async function readModelInfo($: Engine, fresh = false) {
  const [seen, sessionModel, settings, ultracodeSet] = await Promise.all([
    read($, seenA),
    $.session.model(),
    readSettings($, fresh),
    read($, ultracodeA),
  ])
  return { ...shownModel(seen, sessionModel, settings.effortFor), ultracode: ultracodeSet ?? settings.isUltracode }
}

/** Shows an effort or ultracode change at once, until the next request reports its own. */
async function noteEffort($: Engine, changed: { effort?: string | null; ultracode?: boolean }) {
  if (changed.effort === undefined && changed.ultracode === undefined) return
  // A saved level is in the settings before this hears of it: what the footer last
  // showed is the before, and the settings are read fresh for the after.
  const before = lastShown ?? (await readModelInfo($))
  settingsCache = null
  if (changed.effort !== undefined) {
    const [seen, sessionModel, settingsFor] = await Promise.all([read($, seenA), $.session.model(), settingsReader($)])
    const model = seen && seen.sessionModel === sessionModel ? seen.model : sessionModel
    const settingsEffort = settingsFor(model)
    await update($, seenA, () => ({ model, sessionModel, effort: changed.effort ?? settingsEffort, settingsEffort }))
  }
  if (changed.ultracode !== undefined) await update($, ultracodeA, () => changed.ultracode ?? null)
  const after = await readModelInfo($)
  const effort = after.effort !== before.effort && hasShimmer(after.effort)
  const ultracode = after.ultracode && !before.ultracode
  if (effort || ultracode) await startShimmer($, effort ? after.effort : null, ultracode)
}

// ------------------------------------------------------------ the shimmer

/** The one pass that runs after a change to xhigh or max, or ultracode turning on. */
type Shimmer = { frame: number; frames: number; effort: boolean; ultracode: boolean }
let shimmer: Shimmer | null = null
let shimmerTimer: Timer | null = null
/** The effort and ultracode the footer last showed: what a change is measured from. */
let lastShown: { effort: string | null; ultracode: boolean } | null = null
/** What the footer last drew from: a shimmer frame redraws it without reading anything again. */
let lastDraw: { m: BarModel; info: Awaited<ReturnType<typeof readModelInfo>> | undefined } | null = null

function stopShimmer() {
  shimmerTimer?.cancel()
  shimmerTimer = null
  shimmer = null
}

async function startShimmer($: Engine, effort: string | null, isUltracode: boolean) {
  stopShimmer()
  if ((await readSettings($)).isReducedMotion) return
  const frames = shimmerFrames(effort, isUltracode)
  if (frames === 0) return
  shimmer = { frame: 0, frames, effort: effort !== null, ultracode: isUltracode }
  // The first frame reads afresh, after the change; the rest draw from it.
  lastDraw = null
  $.ui.invalidate('ui.render')
  shimmerTimer = $.clock.every(FRAME_MS, () => {
    if (!shimmer) return
    shimmer = { ...shimmer, frame: shimmer.frame + 1 }
    // Past the last frame: one more redraw, static.
    if (shimmer.frame >= shimmer.frames) stopShimmer()
    $.ui.invalidate('ui.render')
  })
}

const shimmerOf = (s: Shimmer | null): ShimmerFrames => ({
  effort: s?.effort ? s.frame : null,
  ultracode: s?.ultracode ? s.frame : null,
})

export const register: Register = (on, options) => {
  pluginOptions = options ?? {}
  on('session.start', async ($, e, next) => {
    sessionIdCache = null
    await safe($, 'loading the caps', () => loadCaps($))
    await safe($, 'adding /usagecap', () =>
      $.command.register({ name: 'usagecap', description: 'Set a cap on the 5-hour or weekly usage: the agent wraps up as it nears it' }),
    )
    await safe($, 'restoring counts', async () => {
      if ((await $.state.get(TOKENS)).version > 0) return
      const saved = sanitizeTokens(await $.store.get(`tokens:${await sessionId($)}`))
      if (saved) await $.state.set(TOKENS, saved)
    })
    await safe($, 'reading usage', () => refresh($, true))
    ticker?.cancel()
    ticker = $.clock.every(TICK_MS, () => $.ui.invalidate('ui.render'))
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    await safe($, 'saving counts', () => persistTokens($))
    if (e.reason === 'clear') {
      await safe($, 'resetting after /clear', async () => {
        await update($, tokensA, () => ZERO)
        await update($, ctxA, c => ({ ...EMPTY_CTX, window: c.window, threshold: c.threshold, isAutoCompact: c.isAutoCompact }))
        sessionIdCache = null
        later($, 800, 'usage after /clear', () => refresh($, true))
      })
    }
    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    await safe($, 'measuring', async () => {
      const before = await read($, ctxA)
      await takeUsage($, e)
      if (before.window !== null && before.window !== e.context.window) await refresh($, true)
    })
    await safe($, 'checking the cap', () => toastAtCap($))
    return next(e)
  })

  on('session.compact', async ($, e, next) => {
    const done = await next(e)
    await safe($, 'after compaction', async () => {
      if (e.agentId !== undefined || done.skip !== undefined) return
      const used = done.usage
      if (used) await update($, tokensA, t => addUsage(t, used))
      if (e.trigger === 'precompute') return
      await update($, ctxA, c => ({ ...c, tokens: null, history: [], estimate: done.tokensAfter ?? c.estimate }))
      later($, 1500, 'usage after compaction', () => refresh($, true))
    })
    return done
  })

  on('turn.step', async function* ($, e, next) {
    const res = yield* next(e)
    const used = res.usage
    if (used) {
      await safe($, 'counting tokens', async () => {
        await update($, tokensA, t => addUsage(t, used))
        if (e.agentId === undefined) await update($, ctxA, c => ({ ...c, tokens: contextOf(used) }))
      })
    }
    if (e.agentId === undefined) {
      await safe($, 'noting the model', async () => {
        const [sessionModel, settingsFor] = await Promise.all([$.session.model(), settingsReader($)])
        const effort = e.effort === undefined ? null : String(e.effort)
        await update($, seenA, () => ({ model: e.model, sessionModel, effort, settingsEffort: settingsFor(e.model) }))
      })
    }
    return res
  })

  on('turn.complete', async ($, e, next) => {
    const out = await next(e)
    if (e.agentId !== undefined) return out
    await safe($, 'turn end', async () => {
      await update($, ctxA, c => (c.tokens === null ? c : { ...c, history: pushHistory(c.history, c.tokens) }))
      await persistTokens($)
    })
    return out
  })

  // `/effort max` and `/effort ultracode on` hold for this session only and reach no
  // settings: the run's arguments say what was set, shown before the next request does.
  on('command.run', { command: 'effort' }, async ($, e, next) => {
    const out = await next(e)
    await safe($, 'noting /effort', () =>
      noteEffort($, parseEffortCommand(e.args, typeof out.text === 'string' ? out.text : '')),
    )
    return out
  }).catch(($, e, next) => next(e))

  // The /effort picker names nothing in its arguments; the line it prints does
  // (`Set effort level to max (this session only)`, `Ultracode on`).
  on('session.append', { door: 'command' }, async ($, e, next) => {
    if (e.agentId === undefined) {
      await safe($, 'reading /effort output', async () => {
        const out = /<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/.exec(JSON.stringify(e.message.content))
        if (out?.[1] && /effort|ultracode/i.test(out[1])) await noteEffort($, parseEffortCommand('', out[1]))
      })
    }
    return next(e)
  })

  // ------------------------------------------------------------ the usage cap

  on('command.run', { command: 'usagecap' }, async ($, e) => {
    const text = await safe($, '/usagecap', () => runCapCommand($, e.args))
    return { text: text ?? 'usagecap: something went wrong; see the debug log.' }
  })

  // Every tool call, the main loop's and each subagent's. Nearing a cap, the
  // result carries a note only the model reads (once per stage per loop); at
  // the cap, in wind-down mode, the call is refused with what to do instead.
  // Anything going wrong here lets the call through untouched.
  on('tool.call', async ($, e, next) => {
    let r: CapReading | null = null
    let over = false
    try {
      if (hasCaps(capsCache)) {
        const reading = await capReading($)
        r = reading.r
        over = r !== null && isOverridden(reading.now)
      }
    } catch (err) {
      debug($, `cap check failed: ${err instanceof Error ? err.message : String(err)}`)
      r = null
    }
    if (r === null) return next(e)
    if (r.stage === 'cap' && capsCache.mode === 'wind-down' && !over) {
      const reading = r
      noteOnce(e.agentId ?? 'main', reading, over)
      await safe($, 'cap toast', () => toastAtCap($))
      return { deny: capDeny(reading) }
    }
    const res = await next(e)
    if (res.deny !== undefined) return res
    const note = noteOnce(e.agentId ?? 'main', r, over)
    return note ? { ...res, context: [...(res.context ?? []), note] } : res
  }).catch(($, e, next) => next(e)) // fail open: a broken check never blocks a tool, nor runs one twice

  // A prompt typed while near or past a cap carries the note too, so a new
  // request is answered in that light (never dropped: the person decides).
  on('prompt.submit', async ($, e, next) => {
    if (e.command) return next(e)
    const reading = await safe($, 'cap on prompt', () => capReading($))
    const r = reading?.r
    if (!reading || !r) return next(e)
    const over = isOverridden(reading.now)
    noteOnce('main', r, over)
    return next({ ...e, context: [...(e.context ?? []), capNote(r, capsCache.mode, over)] })
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'PromptHint', surface: 'terminal' }, async ($, e, next) => {
    const engine = await next(e)
    // A shimmer frame changes only the effort's colours: it draws from what the last draw read.
    const [m, info] =
      shimmer && lastDraw
        ? [lastDraw.m, lastDraw.info]
        : await Promise.all([readModel($), safe($, 'reading the model', () => readModelInfo($))])
    lastDraw = { m, info }
    if (info) lastShown = { effort: info.effort, ultracode: info.ultracode }
    const { Box, Text } = $.ui.resolve(e)
    // The footer's width; the mode labels (SessionMode) take theirs from its right end.
    const cols = Math.max(24, (e.viewport?.columns ?? 100) - 4 - modesWidth)
    const model = info ? modelParts(info.model, info.effort, info.ultracode, shimmerOf(shimmer)) : []
    const hasModel = model.length > 0 && e.props.hint.length > 0 && strWidth(e.props.hint) + 3 + partsWidth(model) <= cols
    // The rows are padded to the footer's width, which stretches the column (a Box
    // holding the engine's line takes no width, and the engine's line shares no row);
    // the model is pinned over the right end of the engine's line.
    return (
      <Box flexDirection="column">
        {engine}
        {line(Text, padRow(ctxLine(m, cols), cols))}
        {line(Text, padRow(limitsLine(m, cols), cols))}
        {hasModel ? (
          <Box position="absolute" top={-1} right={0}>
            {line(Text, model)}
          </Box>
        ) : null}
      </Box>
    )
  })

  // The footer's right end, where the engine draws its mode labels (`focus`): their
  // width is taken off the rows beside them.
  on('ui.render', { component: 'SessionMode', surface: 'terminal' }, async ($, e, next) => {
    const width = e.props.modes.length > 0 ? strWidth(e.props.modes.join(' & ')) + 2 : 0
    if (width !== modesWidth) {
      modesWidth = width
      $.ui.invalidate('ui.render')
    }
    return next(e)
  })
}

type TextElement = ReturnType<EngineInterface['ui']['resolve']>['Text']

function line(Text: TextElement, parts: readonly Part[]) {
  return (
    <Text wrap="truncate-end">
      {parts.map(p => (
        <Text
          {...(p.color ? { color: p.color } : {})}
          {...(p.dim ? { dimColor: true } : {})}
          {...(p.bold ? { bold: true } : {})}
        >
          {p.text}
        </Text>
      ))}
    </Text>
  )
}

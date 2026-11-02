// Pure logic: no `$`, so the tests can drive it directly.

import type { BarContext, BarLimit, BarSeen, BarSession, BarTokens } from '../types'
import { capCell, capFor, capLabel, stageOf, withCapMark } from './cap'
import type { Caps } from './cap'

export const ZERO: BarTokens = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, requests: 0 }
export const EMPTY_CTX: BarContext = {
  tokens: null,
  window: null,
  threshold: null,
  isAutoCompact: true,
  estimate: null,
  history: [],
}
export const EMPTY_SESSION: BarSession = { costUsd: null }

export type BarModel = {
  tokens: BarTokens
  ctx: BarContext
  limits: readonly BarLimit[]
  session: BarSession
  now: number
  /** The session's directory, absolute; drawn at the right end of the ctx row. */
  cwd: string | null
  /** Claude's config folder (CLAUDE_CONFIG_DIR, else ~/.claude); drawn at the right end of the limits row. */
  home: string | null
  /** The usage caps; absent or none set, the limits row draws as it always has. */
  caps?: Caps
  /** `/usagecap override` holds: past the cap, nothing is refused. */
  isOverridden?: boolean
}

// ---------------------------------------------------------------- tokens

/** The four counts as the API spells them (ModelUsage). */
export type UsageLike = {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
}

const count = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0)

export function addUsage(t: BarTokens, u: UsageLike): BarTokens {
  return {
    input: t.input + count(u.input_tokens),
    cacheRead: t.cacheRead + count(u.cache_read_input_tokens),
    cacheWrite: t.cacheWrite + count(u.cache_creation_input_tokens),
    output: t.output + count(u.output_tokens),
    requests: t.requests + 1,
  }
}

/** Everything sent as input: uncached, cache read and cache write. */
export const inputOf = (t: BarTokens) => t.input + t.cacheRead + t.cacheWrite
/** A response's input side: what the status line calls the context's fill. */
export const contextOf = (u: UsageLike) =>
  count(u.input_tokens) + count(u.cache_read_input_tokens) + count(u.cache_creation_input_tokens)

const rec = (v: unknown) => (v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined)
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0)

/** A session's counts read back from the store; undefined when there were none. */
export function sanitizeTokens(raw: unknown): BarTokens | undefined {
  const r = rec(raw)
  if (!r) return undefined
  return {
    input: num(r.input),
    cacheRead: num(r.cacheRead),
    cacheWrite: num(r.cacheWrite),
    output: num(r.output),
    requests: num(r.requests),
  }
}

// ---------------------------------------------------------------- formatting

const trimZeros = (s: string) => (s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s)

export function fmtTokens(value: number): string {
  const v = Math.max(0, Math.round(Number.isFinite(value) ? value : 0))
  if (v < 1000) return String(v)
  if (v < 99_950) return `${trimZeros((v / 1000).toFixed(1))}k`
  if (v < 999_500) return `${Math.round(v / 1000)}k`
  if (v < 9_995_000) return `${trimZeros((v / 1e6).toFixed(2))}M`
  if (v < 99_950_000) return `${trimZeros((v / 1e6).toFixed(1))}M`
  return `${Math.round(v / 1e6)}M`
}

/** A span to the minute: `45m`, `2h 14m`, `3d 4h`; under a minute reads `<1m`. */
export function fmtSpan(ms: number): string {
  const m = Math.floor(Math.max(0, ms) / 60_000)
  if (m < 1) return '<1m'
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`
  const d = Math.floor(h / 24)
  return h % 24 ? `${d}d ${h % 24}h` : `${d}d`
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const pad2 = (n: number) => String(n).padStart(2, '0')

/** The local wall-clock time of `at`: `16:30` today, `Mon 09:00` on another day. */
export function fmtClock(at: number, now: number): string {
  const d = new Date(at)
  const hm = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
  return new Date(now).toDateString() === d.toDateString() ? hm : `${DAYS[d.getDay()]} ${hm}`
}

export const fmtUsd = (usd: number) => `$${usd >= 100 ? usd.toFixed(0) : usd.toFixed(2)}`
export const pct = (frac: number) => `${Math.round(frac * 100)}%`
export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

// ---------------------------------------------------------------- terminal width

/** Cells a code point takes: 0 for controls and combining marks, 2 for wide ones. */
export function charWidth(cp: number): number {
  if (cp < 32 || (cp >= 0x7f && cp < 0xa0)) return 0
  if (
    (cp >= 0x300 && cp <= 0x36f) ||
    (cp >= 0x200b && cp <= 0x200f) ||
    (cp >= 0xfe00 && cp <= 0xfe0f) ||
    cp === 0x200d
  )
    return 0
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1f64f) ||
    (cp >= 0x1f680 && cp <= 0x1f6ff) ||
    (cp >= 0x1f900 && cp <= 0x1f9ff) ||
    (cp >= 0x1fa70 && cp <= 0x1faff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  )
    return 2
  return 1
}

export function strWidth(s: string): number {
  let w = 0
  for (const ch of s) w += charWidth(ch.codePointAt(0) ?? 0)
  return w
}

// ---------------------------------------------------------------- the context window

export type CtxView = {
  frac: number | null
  /** Tokens left before auto-compaction runs; null when off or unknown. */
  left: number | null
  isEstimate: boolean
  isAutoCompact: boolean
  /** Main turns left at the recent pace; null until there is a pace. */
  turns: number | null
}

export function ctxView(c: BarContext): CtxView {
  const used = c.tokens ?? c.estimate
  const limit = c.isAutoCompact && c.threshold ? c.threshold : c.window
  const left = c.isAutoCompact && c.threshold && used !== null ? c.threshold - used : null
  return {
    frac: used !== null && limit ? used / limit : null,
    left,
    isEstimate: c.tokens === null && c.estimate !== null,
    isAutoCompact: c.isAutoCompact,
    turns: turnsLeft(c.history, left),
  }
}

/** Turns left at the average growth of the last few main turns. */
export function turnsLeft(history: readonly number[], left: number | null): number | null {
  if (left === null) return null
  if (left <= 0) return 0
  const deltas: number[] = []
  for (let i = 1; i < history.length; i++) {
    const d = (history[i] ?? 0) - (history[i - 1] ?? 0)
    if (d > 0) deltas.push(d)
  }
  const recent = deltas.slice(-5)
  if (recent.length === 0) return null
  const avg = recent.reduce((a, b) => a + b, 0) / recent.length
  return Math.max(0, Math.floor(left / avg))
}

export const pushHistory = (h: readonly number[], v: number) => [...h, v].slice(-12)

export const levelColor = (frac: number | null) =>
  frac === null ? 'subtle' : frac >= 0.85 ? 'error' : frac >= 0.6 ? 'warning' : 'success'

export function bar(frac: number | null, width: number): { filled: string; empty: string } {
  const f = frac === null ? 0 : Math.max(0, Math.min(1, frac))
  const k = Math.round(f * width)
  return { filled: '█'.repeat(k), empty: '░'.repeat(Math.max(0, width - k)) }
}

// ---------------------------------------------------------------- rate limits

const ORDER = ['five_hour', 'seven_day']

/** The windows as the engine reports them, kept in a steady order: 5h, week, the rest. */
export function toLimits(raw: readonly { kind: string; percentUsed: number; resetsAt?: string }[]): BarLimit[] {
  const rank = (k: string) => {
    const i = ORDER.indexOf(k)
    return i === -1 ? ORDER.length : i
  }
  return raw
    .filter(r => typeof r.kind === 'string' && Number.isFinite(r.percentUsed))
    .map(r => {
      const at = r.resetsAt ? Date.parse(r.resetsAt) : NaN
      return { kind: r.kind, percentUsed: r.percentUsed, resetsAt: Number.isFinite(at) ? at : null }
    })
    .sort((a, b) => rank(a.kind) - rank(b.kind) || a.kind.localeCompare(b.kind))
}

/** `5h`, `week`, `week opus`, `spend`: the window's name on the row. */
export function limitLabel(kind: string): string {
  if (kind === 'five_hour') return '5h'
  if (kind === 'seven_day') return 'week'
  if (kind.startsWith('seven_day_')) return `week ${kind.slice('seven_day_'.length).replace(/_/g, ' ')}`
  if (kind === 'spend_limit') return 'spend'
  return kind.replace(/_/g, ' ')
}

// ---------------------------------------------------------------- the rows under the prompt

export type Part = { text: string; color?: string; dim?: boolean; bold?: boolean }

/** A piece of a line: dropped from the highest `prio` down when the line runs out of room. */
export type Seg = { parts: Part[]; prio: number; sep?: string }

const SEP = ' · '
const GROUP = '  │  '

export const partsWidth = (parts: readonly Part[]) => parts.reduce((w, p) => w + strWidth(p.text), 0)

/** Lays segments into `cols` cells, dropping the highest `prio` first; prio 0 always stays. */
export function fitLine(segs: readonly Seg[], cols: number): Part[] {
  let kept = [...segs]
  const sepOf = (s: Seg, i: number) => (i === 0 ? '' : (s.sep ?? SEP))
  const width = () => kept.reduce((w, s, i) => w + partsWidth(s.parts) + strWidth(sepOf(s, i)), 0)
  while (width() > cols) {
    let worst: Seg | undefined
    for (const s of kept) if (s.prio > 0 && (!worst || s.prio >= worst.prio)) worst = s
    if (!worst) break
    kept = kept.filter(s => s !== worst)
  }
  const out: Part[] = []
  kept.forEach((s, i) => {
    const sep = sepOf(s, i)
    if (sep) out.push({ text: sep, dim: true })
    out.push(...s.parts)
  })
  return out
}

const barWidthFor = (cols: number) => (cols >= 150 ? 12 : cols >= 110 ? 10 : cols >= 80 ? 8 : 5)

function compactLeft(v: CtxView, color: string): Part[] {
  if (!v.isAutoCompact) return [{ text: 'auto-compact off', dim: true }]
  if (v.left === null) return [{ text: 'measuring…', dim: true }]
  if (v.left <= 0) return [{ text: 'compacts next turn', color: 'error', bold: true }]
  return [
    { text: `${v.isEstimate ? '~' : ''}${fmtTokens(v.left)}`, color },
    { text: ' to compact', dim: true },
  ]
}

/** ctx bar, tokens to compaction, turns left, tokens in/out/total, cache share and cost. */
export function ctxLine(m: BarModel, cols: number): Row {
  const v = ctxView(m.ctx)
  const color = levelColor(v.frac)
  const inTok = inputOf(m.tokens)
  const b = bar(v.frac, barWidthFor(cols))
  const fill = v.frac === null ? '—' : `${v.isEstimate ? '~' : ''}${pct(v.frac)}`

  const segs: Seg[] = [
    {
      prio: 0,
      parts: [
        { text: 'ctx  ', dim: true },
        { text: b.filled, color },
        { text: b.empty, dim: true },
        { text: ` ${fill}`, color, bold: (v.frac ?? 0) >= 0.85 },
      ],
    },
    { prio: 1, parts: compactLeft(v, color) },
  ]
  if (v.turns !== null && v.left !== null && v.left > 0) {
    segs.push({ prio: 4, parts: [{ text: `≈${plural(v.turns, 'turn')}`, dim: true }] })
  }
  segs.push(
    cols >= 110
      ? {
          prio: 0,
          sep: GROUP,
          parts: [
            { text: 'in ', dim: true },
            { text: fmtTokens(inTok) },
            { text: '  out ', dim: true },
            { text: fmtTokens(m.tokens.output) },
            { text: '  total ', dim: true },
            { text: fmtTokens(inTok + m.tokens.output), bold: true },
          ],
        }
      : {
          prio: 0,
          sep: GROUP,
          parts: [
            { text: '↑', dim: true },
            { text: fmtTokens(inTok) },
            { text: ' ↓', dim: true },
            { text: fmtTokens(m.tokens.output) },
            { text: ' Σ', dim: true },
            { text: fmtTokens(inTok + m.tokens.output), bold: true },
          ],
        },
  )
  if (inTok > 0) segs.push({ prio: 3, parts: [{ text: `${pct(m.tokens.cacheRead / inTok)} cached`, dim: true }] })
  if (m.session.costUsd !== null) segs.push({ prio: 2, parts: [{ text: fmtUsd(m.session.costUsd), dim: true }] })
  const line = fitLine(segs, cols)
  return m.cwd ? alignRight(line, { text: 'CWD: ', dim: true }, { text: m.cwd, color: 'claude' }, cols) : { left: line, right: [] }
}

const RIGHT_GAP = 3
const RIGHT_MIN = 16

/** Cuts `s` from the left to `max` cells, so a path keeps its last folders: `…/src/app`. */
export function truncateStart(s: string, max: number): string {
  if (max <= 0) return ''
  if (strWidth(s) <= max) return s
  const chars = [...s]
  let out = ''
  let w = 0
  for (let i = chars.length - 1; i >= 0; i--) {
    const ch = chars[i] ?? ''
    const cw = charWidth(ch.codePointAt(0) ?? 0)
    if (w + cw > max - 1) break
    out = ch + out
    w += cw
  }
  return `…${out}`
}

/** A row under the prompt: `right` flush with its end once padded (padRow). */
export type Row = { left: Part[]; right: Part[] }

/** The row as one line of `cols` cells, spaces between its ends. */
export function padRow(r: Row, cols: number): Part[] {
  if (r.right.length === 0) return r.left
  const gap = Math.max(1, cols - partsWidth(r.left) - partsWidth(r.right))
  return [...r.left, { text: ' '.repeat(gap) }, ...r.right]
}

/**
 * Fits `label` and `right` beside `left` in `cols`: `right` is cut from its
 * start when tight, and both are left out when under RIGHT_MIN cells of it
 * would show.
 */
export function alignRight(left: Part[], label: Part, right: Part, cols: number): Row {
  const room = cols - partsWidth(left) - RIGHT_GAP - strWidth(label.text)
  if (room < Math.min(RIGHT_MIN, strWidth(right.text))) return { left, right: [] }
  return { left, right: [label, { ...right, text: truncateStart(right.text, room) }] }
}

/** The limits row, with Claude's home (its config folder) at the right end. */
export function limitsLine(m: BarModel, cols: number): Row {
  const line = limitBars(m, cols)
  return m.home ? alignRight(line, { text: '⌂ ', color: 'ide', bold: true }, { text: m.home, color: 'claude' }, cols) : { left: line, right: [] }
}

/** One bar per rate-limit window, with how long until it resets and the local time it does. */
function limitBars(m: BarModel, cols: number): Part[] {
  if (m.limits.length === 0) {
    return [
      { text: '5h   ', dim: true },
      { text: '—', dim: true },
      { text: GROUP, dim: true },
      { text: 'week ', dim: true },
      { text: '—', dim: true },
      { text: '  no reading yet: limits show after the next reply', dim: true },
    ]
  }
  const width = barWidthFor(cols)
  const segs: Seg[] = []
  m.limits.forEach((l, i) => {
    const sep = i === 0 ? undefined : GROUP
    const label = limitLabel(l.kind)
    // The first label pads to "ctx  " so the bars line up with the ctx bar above.
    const head = i === 0 ? label.padEnd(4) + ' ' : `${label} `
    const isPast = l.resetsAt !== null && l.resetsAt <= m.now
    if (isPast) {
      segs.push({
        prio: 0,
        sep,
        parts: [
          { text: head, dim: true },
          { text: '░'.repeat(width), dim: true },
          { text: ' reset', color: 'success' },
        ],
      })
      segs.push({ prio: 2 + i, parts: [{ text: 'refreshes on the next reply', dim: true }] })
      return
    }
    const frac = l.percentUsed / 100
    const color = levelColor(frac)
    const b = bar(frac, width)
    const cap = m.caps ? capFor(l.kind, m.caps) : null
    const marked = withCapMark(b.filled, b.empty, capCell(cap, width))
    segs.push({
      prio: 0,
      sep,
      parts: [
        { text: head, dim: true },
        { text: marked.filled, color },
        { text: marked.before, dim: true },
        ...(marked.mark ? [{ text: marked.mark, color: 'warning' }, { text: marked.after, dim: true }] : []),
        { text: ` ${Math.round(l.percentUsed)}%`, color, bold: frac >= 0.85 },
      ],
    })
    if (cap !== null && m.caps) {
      const stage = stageOf(l.percentUsed, cap, m.caps)
      segs.push({ prio: stage === 'ok' ? 2 : 0, parts: capLabel(stage, cap, m.caps.mode, m.isOverridden === true) })
    }
    if (l.resetsAt !== null) {
      segs.push({
        prio: 1,
        parts: [
          { text: 'resets in ', dim: true },
          { text: fmtSpan(l.resetsAt - m.now) },
        ],
      })
      segs.push({ prio: 3, parts: [{ text: fmtClock(l.resetsAt, m.now), dim: true }] })
    }
  })
  return fitLine(segs, cols)
}

const text = (parts: readonly Part[]) => parts.map(p => p.text).join('')
/** Each row as plain text, its right end after a space. */
export const rowsText = (rows: readonly Row[]) => rows.map(r => (r.right.length ? `${text(r.left)} ${text(r.right)}` : text(r.left)))

// ---------------------------------------------------------------- model and effort

/** `claude-opus-5-5[1m]` → `Opus 5.5 (1M)`; an alias or another name reads as given, capitalised. */
export function modelLabel(id: string): string {
  const ctx = /\[(\w+)\]$/.exec(id)
  const base = id.replace(/\[\w+\]$/, '')
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/.exec(base)
  const cap = (w: string) => w.charAt(0).toUpperCase() + w.slice(1)
  const name = m ? `${cap(m[1] ?? '')} ${m[2]}${m[3] ? `.${m[3]}` : ''}` : /^[a-z]+$/.test(base) ? cap(base) : base
  return ctx ? `${name} (${(ctx[1] ?? '').toUpperCase()})` : name
}

const rec2 = (v: unknown) => (v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined)
const level = (v: unknown) => (typeof v === 'string' && v ? v : typeof v === 'number' ? String(v) : null)

/** The effort the settings give `model`: its `modelSettings` entry, else the top-level `effortLevel`. */
export function settingsEffort(modelSettings: unknown, effortLevel: unknown, model: string): string | null {
  const all = rec2(modelSettings)
  const base = model.replace(/\[\w+\]$/, '')
  return level(rec2(all?.[model])?.effortLevel) ?? level(rec2(all?.[base])?.effortLevel) ?? level(effortLevel)
}

/**
 * The model and effort to show: what the last main request ran on, unless the
 * session has switched model since, or the settings' effort has changed (an
 * `/effort` between turns).
 */
export function shownModel(
  seen: BarSeen | null,
  sessionModel: string,
  settingsFor: (model: string) => string | null,
): { model: string; effort: string | null } {
  if (!seen || seen.sessionModel !== sessionModel) return { model: sessionModel, effort: settingsFor(sessionModel) }
  const now = settingsFor(seen.model)
  return { model: seen.model, effort: now !== seen.settingsEffort ? now : seen.effort }
}

const LEVELS = ['low', 'medium', 'high', 'xhigh', 'max']

/**
 * What an `/effort` run changed, read from its arguments (`max`, `ultracode on`)
 * and, where the engine answers in text, from that (`Set effort level to max`;
 * the terminal's answer is a panel, no text): `effort` null when it went back
 * to the default (`auto`, `unset`), undefined when the run named no level (the
 * picker, whose pick the next request reports, or a status read).
 */
export function parseEffortCommand(args: string, text: string): { effort?: string | null; ultracode?: boolean } {
  const a = args.trim().toLowerCase()
  const out: { effort?: string | null; ultracode?: boolean } = {}
  const set = /set effort level to ([a-z]+)/i.exec(text)
  if (LEVELS.includes(a)) out.effort = a
  else if (set?.[1]) out.effort = set[1].toLowerCase()
  if (a === 'auto' || a === 'unset' || out.effort === 'auto' || out.effort === 'unset') out.effort = null
  const ultra = /\bultracode\s+(on|off)\b/i.exec(a) ?? /\bultracode\s+(on|off)\b/i.exec(text)
  if (ultra?.[1]) out.ultracode = ultra[1].toLowerCase() === 'on'
  return out
}

/** The rainbow Claude Code draws `max` in (its rainbow_* theme colours, the same in every truecolor theme). */
const RAINBOW = ['#eb5f57', '#f58b57', '#fac35f', '#91c882', '#82aadc', '#9b82c8', '#c882b4']
/** Where `max` starts in the rainbow: green, blue, indigo, as the /effort picker shows it. */
const RAINBOW_START = 3

/** The highlight Claude Code sweeps through `xhigh` and `ultracode` (autoAcceptShimmer, the same in every truecolor theme). */
const SHIMMER = '#d0b4ff'
/** How long one shimmer frame stands, as Claude Code's ultracode sweep. */
export const FRAME_MS = 120

/**
 * The frames one pass takes: xhigh's highlight runs past both ends (Claude
 * Code's sweep), max's rainbow turns once round, ultracode's highlight runs in
 * from before its first letter to past its last.
 */
export const shimmerFrames = (effort: string | null, isUltracode: boolean) =>
  Math.max(effort === 'xhigh' ? 'xhigh'.length + 4 : effort === 'max' ? RAINBOW.length : 0, isUltracode ? ULTRACODE.text.length + 2 : 0)

/** Whether a level has a shimmer: the two the /effort picker animates. */
export const hasShimmer = (effort: string | null) => effort === 'xhigh' || effort === 'max'

/** `text` with the letter at `at` in the highlight and its neighbours bold, the rest `color`. */
function sweep(text: string, color: string, at: number, isBold: boolean): Part[] {
  return [...text].map((ch, i) =>
    i === at
      ? { text: ch, color: SHIMMER, bold: true }
      : { text: ch, color, ...(isBold || i === at - 1 || i === at + 1 ? { bold: true } : {}) },
  )
}

/**
 * Each level in the colour the /effort picker gives it: low amber, medium
 * green, high the permission blue, xhigh the auto-accept violet, max a
 * rainbow. A level the picker does not name (a number) stays muted. `frame`
 * is the shimmer's frame while one runs, past its last it draws static.
 */
export function effortParts(effort: string, frame: number | null = null): Part[] {
  if (effort === 'xhigh' && frame !== null && frame < effort.length + 4) return sweep(effort, 'autoAccept', frame, true)
  const color = ({ low: 'warning', medium: 'success', high: 'permission', xhigh: 'autoAccept' } as Record<string, string>)[effort]
  if (color) return [{ text: effort, color, bold: true }]
  if (effort === 'max') {
    const turn = frame !== null && frame < RAINBOW.length ? frame : 0
    return [...effort].map((ch, i) => ({ text: ch, color: RAINBOW[(RAINBOW_START + turn + i) % RAINBOW.length], bold: true }))
  }
  return [{ text: effort, dim: true }]
}

/** `ultracode` as Claude Code draws it: the effortUltra violet (autoAccept's in every theme), swept while `frame` runs. */
export const ULTRACODE: Part = { text: 'ultracode', color: 'autoAccept', bold: true }

export function ultracodeParts(frame: number | null = null): Part[] {
  if (frame === null || frame >= ULTRACODE.text.length + 2) return [ULTRACODE]
  return sweep(ULTRACODE.text, 'autoAccept', frame - 1, false)
}

/** The shimmer frame each part draws: null for a part that stands still. */
export type ShimmerFrames = { effort: number | null; ultracode: number | null }

/** `✻ Opus 5.5 · xhigh · ultracode`, for the right end of the engine's line. */
export function modelParts(
  model: string,
  effort: string | null,
  isUltracode = false,
  shimmer: ShimmerFrames = { effort: null, ultracode: null },
): Part[] {
  const sep: Part = { text: ' · ', dim: true }
  return [
    { text: '✻ ', color: 'claude' },
    { text: modelLabel(model), dim: true },
    ...(effort ? [sep, ...effortParts(effort, shimmer.effort)] : []),
    ...(isUltracode ? [sep, ...ultracodeParts(shimmer.ultracode)] : []),
  ]
}

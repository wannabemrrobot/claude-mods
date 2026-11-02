// The usage cap: pure logic, no `$`, so the tests can drive it directly.
//
// A cap is a percentage of a rate-limit window (5-hour or weekly). As usage
// nears it the agent is told, once per stage, to find a stopping point, then to
// wrap up; at the cap its tool calls are refused so it writes a handoff and stops.
// No turn is ever cancelled.

import type { BarLimit } from '../types'
import type { Part } from './lib'

export type CapMode = 'wind-down' | 'warn-only'

export type Caps = {
  /** Percent of the 5-hour window; null: no cap. */
  fiveHour: number | null
  /** Percent of the weekly window (and any per-model weekly one); null: no cap. */
  week: number | null
  /** Points below the cap where the heads-up starts. */
  warnAt: number
  /** Points below the cap where the wrap-up starts. */
  wrapAt: number
  mode: CapMode
}

export const NO_CAPS: Caps = { fiveHour: null, week: null, warnAt: 10, wrapAt: 3, mode: 'wind-down' }

export type Stage = 'ok' | 'warn' | 'wrap' | 'cap'
const RANK: Record<Stage, number> = { ok: 0, warn: 1, wrap: 2, cap: 3 }
export const stageRank = (s: Stage) => RANK[s]

/** A whole percent from 1 to 100, else null (0, blank, off or nonsense: no cap). */
export function capValue(v: unknown): number | null {
  const n = typeof v === 'string' ? Number(v.trim().replace(/%$/, '')) : v
  if (typeof n !== 'number' || !Number.isFinite(n)) return null
  const r = Math.round(n)
  return r >= 1 && r <= 100 ? r : null
}

const points = (v: unknown, fallback: number) => {
  const n = typeof v === 'string' ? Number(v) : v
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 50 ? Math.round(n) : fallback
}

/** The caps from the plugin's options (`/config`), then whatever `/usagecap` saved over them. */
export function capsFrom(options: Readonly<Record<string, unknown>>, saved: unknown): Caps {
  const s = saved !== null && typeof saved === 'object' && !Array.isArray(saved) ? (saved as Record<string, unknown>) : {}
  const pick = (key: string) => (key in s ? s[key] : options[key])
  const warnAt = points(pick('warnAt'), NO_CAPS.warnAt)
  return {
    fiveHour: capValue(pick('cap5h')),
    week: capValue(pick('capWeek')),
    warnAt,
    wrapAt: Math.min(points(pick('wrapAt'), NO_CAPS.wrapAt), warnAt),
    mode: pick('onCap') === 'warn-only' ? 'warn-only' : 'wind-down',
  }
}

/** The cap that applies to a window: 5h to `five_hour`, the weekly one to every `seven_day*`. */
export function capFor(kind: string, caps: Caps): number | null {
  if (kind === 'five_hour') return caps.fiveHour
  if (kind === 'seven_day' || kind.startsWith('seven_day_')) return caps.week
  return null
}

export function stageOf(percent: number, cap: number | null, caps: Caps): Stage {
  if (cap === null) return 'ok'
  if (percent >= cap) return 'cap'
  if (percent >= cap - caps.wrapAt) return 'wrap'
  if (percent >= cap - caps.warnAt) return 'warn'
  return 'ok'
}

/** The window nearest its cap; a window past its reset counts as fresh. */
export type CapReading = { stage: Stage; kind: string; percent: number; cap: number; resetsAt: number | null }

export function worstStage(limits: readonly BarLimit[], caps: Caps, now: number): CapReading | null {
  let worst: CapReading | null = null
  for (const l of limits) {
    const cap = capFor(l.kind, caps)
    if (cap === null) continue
    if (l.resetsAt !== null && l.resetsAt <= now) continue
    const stage = stageOf(l.percentUsed, cap, caps)
    if (stage === 'ok') continue
    const r = { stage, kind: l.kind, percent: Math.round(l.percentUsed), cap, resetsAt: l.resetsAt }
    if (!worst || RANK[stage] > RANK[worst.stage] || (stage === worst.stage && cap - r.percent < worst.cap - worst.percent)) worst = r
  }
  return worst
}

const windowName = (kind: string) =>
  kind === 'five_hour' ? '5-hour' : kind === 'seven_day' ? 'weekly' : kind.startsWith('seven_day_') ? `weekly ${kind.slice(10).replace(/_/g, ' ')}` : kind

/** What the model reads beside a tool result or a prompt, for the stage a reading is at. */
export function capNote(r: CapReading, mode: CapMode, isOverridden = false): string {
  const at = `Usage note from the usagebar mod: the ${windowName(r.kind)} rate-limit window is at ${r.percent}%, and the user's cap is ${r.cap}%.`
  switch (r.stage) {
    case 'warn':
      return `${at} Aim for a natural stopping point soon and don't start new large pieces of work.`
    case 'wrap':
      return `${at} Wrap up now: finish the current step, leave the work in a working state (building, tests passing where you can), then write a short handoff for the user (what's done, what's next, anything open) and stop.`
    case 'cap':
      if (isOverridden) return `${at} The cap is reached, but the user chose to keep going for now. Keep the remaining work small.`
      return mode === 'warn-only'
        ? `${at} The cap is reached. Stop at the next safe point and write a short handoff for the user (what's done, what's next, anything open).`
        : `${at} The cap is reached: tool calls are now refused. Don't start new work. Write a short handoff for the user (what's done, what's next, anything open) and end the turn.`
    default:
      return ''
  }
}

/** The refusal a tool call gets at the cap. */
export const capDeny = (r: CapReading) =>
  `Usage cap reached: the ${windowName(r.kind)} window is at ${r.percent}% (cap ${r.cap}%), so the usagebar mod refuses tool calls. Write a short handoff for the user (what's done, what's next, anything open) and end the turn. The user can run /usagecap override to continue.`

// ---------------------------------------------------------------- /usagecap

export type CapCommand =
  | { kind: 'show' }
  | { kind: 'set'; patch: Record<string, number | string | null> }
  | { kind: 'off' }
  | { kind: 'reset' }
  | { kind: 'override' }
  | { kind: 'help'; error?: string }

export const CAP_HELP = [
  'Usage:',
  '  /usagecap                 show the caps',
  '  /usagecap 5h 80           cap the 5-hour window at 80%',
  '  /usagecap week 60         cap the weekly window at 60%',
  '  /usagecap 5h off          remove one cap',
  '  /usagecap warn 10         heads-up this many points below a cap',
  '  /usagecap wrap 3          wrap-up this many points below a cap',
  '  /usagecap mode warn-only  only tell the agent; never refuse tool calls (or: wind-down)',
  '  /usagecap off             remove both caps',
  '  /usagecap override        keep going past the cap until the window resets',
  '  /usagecap reset           drop what /usagecap set and go back to /config',
].join('\n')

export function parseCapCommand(args: string): CapCommand {
  const words = args.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (words.length === 0 || words[0] === 'show' || words[0] === 'status') return { kind: 'show' }
  const [a, b] = words
  if (words.length === 1) {
    if (a === 'off') return { kind: 'off' }
    if (a === 'reset') return { kind: 'reset' }
    if (a === 'override') return { kind: 'override' }
    if (a === 'help') return { kind: 'help' }
    return { kind: 'help', error: `Not understood: ${args.trim()}` }
  }
  if (words.length !== 2 || b === undefined) return { kind: 'help', error: `Not understood: ${args.trim()}` }
  const capKey = a === '5h' || a === '5-hour' || a === 'hour' || a === 'hourly' ? 'cap5h' : a === 'week' || a === 'weekly' || a === '7d' ? 'capWeek' : null
  if (capKey) {
    if (b === 'off' || b === '0') return { kind: 'set', patch: { [capKey]: null } }
    const v = capValue(b)
    return v === null ? { kind: 'help', error: `A cap is a percent from 1 to 100, not "${b}".` } : { kind: 'set', patch: { [capKey]: v } }
  }
  if (a === 'warn' || a === 'wrap') {
    const n = Number(b)
    return Number.isInteger(n) && n >= 0 && n <= 50
      ? { kind: 'set', patch: { [a === 'warn' ? 'warnAt' : 'wrapAt']: n } }
      : { kind: 'help', error: `${a} takes a number of points from 0 to 50, not "${b}".` }
  }
  if (a === 'mode') {
    return b === 'wind-down' || b === 'warn-only'
      ? { kind: 'set', patch: { onCap: b } }
      : { kind: 'help', error: `mode is wind-down or warn-only, not "${b}".` }
  }
  return { kind: 'help', error: `Not understood: ${args.trim()}` }
}

/** The caps as one line, for /usagecap's answer. */
export function describeCaps(c: Caps): string {
  const one = (v: number | null) => (v === null ? 'off' : `${v}%`)
  if (c.fiveHour === null && c.week === null) return 'No usage caps set. Try /usagecap 5h 80.'
  return `5h cap ${one(c.fiveHour)} · week cap ${one(c.week)} · heads-up ${c.warnAt} pts before, wrap-up ${c.wrapAt} pts before · ${c.mode}`
}

// ---------------------------------------------------------------- on the bar

/** Where the cap sits on a bar `width` cells wide: the cell index, or null when off it. */
export function capCell(cap: number | null, width: number): number | null {
  if (cap === null || width <= 0 || cap >= 100) return null
  return Math.min(width - 1, Math.max(0, Math.round((cap / 100) * width)))
}

/** The bar's cells split at the cap: `▏` in place of the empty cell it falls on. */
export function withCapMark(filled: string, empty: string, cell: number | null): { filled: string; before: string; mark: string; after: string } {
  const f = [...filled]
  const e = [...empty]
  // No cap, or already past it: the label says so.
  if (cell === null || cell < f.length) return { filled, before: empty, mark: '', after: '' }
  const at = cell - f.length
  return { filled, before: e.slice(0, at).join(''), mark: '▏', after: e.slice(at + 1).join('') }
}

/** The label after a window's percent: `cap 80%`, coloured by the stage. */
export function capLabel(stage: Stage, cap: number, mode: CapMode, isOverridden: boolean): Part[] {
  if (stage === 'cap') {
    const text = isOverridden ? `past cap ${cap}% (override)` : mode === 'warn-only' ? `cap ${cap}% reached` : `paused at cap ${cap}%`
    return [{ text, color: 'error', bold: true }]
  }
  if (stage === 'wrap') return [{ text: `cap ${cap}% · wrapping up`, color: 'warning', bold: true }]
  if (stage === 'warn') return [{ text: `cap ${cap}%`, color: 'warning' }]
  return [{ text: `cap ${cap}%`, dim: true }]
}

import { describe, expect, mock, test } from 'claude-code/testing'
import type { On, SessionUsage } from 'claude-code'
import type { TestBody } from 'claude-code/testing'

import {
  NO_CAPS,
  capCell,
  capFor,
  capNote,
  capsFrom,
  capValue,
  describeCaps,
  parseCapCommand,
  stageOf,
  withCapMark,
  worstStage,
} from '../hooks/cap'
import type { Caps } from '../hooks/cap'
import { EMPTY_CTX, EMPTY_SESSION, ZERO, limitsLine, rowsText, strWidth, toLimits } from '../hooks/lib'
import type { BarModel } from '../hooks/lib'

const NOW = Date.parse('2026-10-28T10:00:00Z')
const H = 3_600_000
const CAPS: Caps = { ...NO_CAPS, fiveHour: 80 }

const usageAt = (fiveHour: number, week = 10): SessionUsage => ({
  startedAt: NOW,
  context: { tokens: 40_000, window: 200_000, percent: 20 },
  rateLimits: [
    { kind: 'five_hour', percentUsed: fiveHour, resetsAt: new Date(NOW + 2 * H).toISOString() },
    { kind: 'seven_day', percentUsed: week, resetsAt: new Date(NOW + 76 * H).toISOString() },
  ],
  cost: { usd: 1 },
})

/** The engine beneath the plugin, as the usagebar tests stand it up, plus what the cap touches. */
function world(on: On, usage: SessionUsage) {
  const clock = mock.clock(on, { now: NOW })
  mock.store(on)
  const toasts: string[] = []
  const prompts: { text: string; context?: readonly string[] }[] = []
  on('ui.log', () => ({ value: undefined }))
  on('ui.invalidate', () => ({ value: undefined }))
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('session.id', () => ({ value: 'sess-1' }))
  on('session.usage', () => ({ value: usage }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  on('session.cwd', () => ({ value: '/Users/me/projects/app' }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('settings.read', () => ({ value: {} }))
  mock.env(on, { HOME: '/Users/me' })
  on('tool.call', () => ({ result: { stdout: 'ok' }, text: 'ok' }))
  on('prompt.submit', (_$, e) => {
    prompts.push({ text: e.text, ...(e.context ? { context: e.context } : {}) })
    return { text: e.text, ...(e.context ? { context: e.context } : {}) }
  })
  on('ui.render', { component: 'PromptHint' }, () => ({ type: 'Text', children: ['? for shortcuts'] }))
  return { clock, toasts, prompts }
}

type E = Parameters<TestBody>[0]

const start = ($: E) =>
  $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
const measure = ($: E, u: SessionUsage) =>
  $.session.measure({ context: u.context, rateLimits: u.rateLimits, changed: ['rateLimits'] })
const usagecap = ($: E, args: string) =>
  $.command.run({ command: 'usagecap', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } })
const prompt = ($: E, text: string) => $.prompt.submit({ text, wait: false, origin: { kind: 'composer' } })
const bash = ($: E, agentId?: string) =>
  $.tool.call({ tool: 'Bash', command: 'ls', ...(agentId ? { agentId } : {}) })

// ---------------------------------------------------------------- pure logic

describe('the cap: settings', () => {
  test('a cap is a whole percent from 1 to 100; 0, blank or nonsense is none', () => {
    expect(capValue(80)).toBe(80)
    expect(capValue('75%')).toBe(75)
    expect(capValue(0)).toBe(null)
    expect(capValue('')).toBe(null)
    expect(capValue(140)).toBe(null)
    expect(capValue('lots')).toBe(null)
  })

  test('/config options, with what /usagecap saved over them', () => {
    expect(capsFrom({}, undefined)).toEqual(NO_CAPS)
    const fromConfig = capsFrom({ cap5h: 80, capWeek: 0, warnAt: 10, wrapAt: 3, onCap: 'wind-down' }, undefined)
    expect(fromConfig).toEqual({ fiveHour: 80, week: null, warnAt: 10, wrapAt: 3, mode: 'wind-down' })
    const saved = capsFrom({ cap5h: 80, onCap: 'wind-down' }, { cap5h: null, capWeek: 60, onCap: 'warn-only' })
    expect(saved).toEqual({ fiveHour: null, week: 60, warnAt: 10, wrapAt: 3, mode: 'warn-only' })
    // The wrap-up never starts before the heads-up.
    expect(capsFrom({ cap5h: 80, warnAt: 2, wrapAt: 5 }, undefined).wrapAt).toBe(2)
  })

  test('the weekly cap covers every weekly window', () => {
    const c = { ...NO_CAPS, fiveHour: 80, week: 60 }
    expect(capFor('five_hour', c)).toBe(80)
    expect(capFor('seven_day', c)).toBe(60)
    expect(capFor('seven_day_opus', c)).toBe(60)
    expect(capFor('spend_limit', c)).toBe(null)
  })
})

describe('the cap: stages', () => {
  test('heads-up at cap − 10, wrap-up at cap − 3, then the cap', () => {
    expect(stageOf(69, 80, CAPS)).toBe('ok')
    expect(stageOf(70, 80, CAPS)).toBe('warn')
    expect(stageOf(77, 80, CAPS)).toBe('wrap')
    expect(stageOf(80, 80, CAPS)).toBe('cap')
    expect(stageOf(99, null, CAPS)).toBe('ok')
  })

  test('the window nearest its cap wins; one past its reset counts as fresh', () => {
    const caps = { ...NO_CAPS, fiveHour: 80, week: 50 }
    const limits = toLimits(usageAt(72, 49).rateLimits)
    expect(worstStage(limits, caps, NOW)).toEqual({ stage: 'wrap', kind: 'seven_day', percent: 49, cap: 50, resetsAt: NOW + 76 * H })
    const past = [{ kind: 'five_hour', percentUsed: 95, resetsAt: NOW - 1000 }]
    expect(worstStage(past, caps, NOW)).toBe(null)
    expect(worstStage(limits, NO_CAPS, NOW)).toBe(null)
  })

  test('each stage tells the model what to do', () => {
    const r = { kind: 'five_hour', percent: 72, cap: 80, resetsAt: null }
    expect(capNote({ ...r, stage: 'warn' }, 'wind-down')).toContain('stopping point')
    expect(capNote({ ...r, stage: 'wrap' }, 'wind-down')).toContain('handoff')
    expect(capNote({ ...r, stage: 'cap' }, 'wind-down')).toContain('refused')
    expect(capNote({ ...r, stage: 'cap' }, 'warn-only')).not.toContain('refused')
    expect(capNote({ ...r, stage: 'cap' }, 'wind-down', true)).toContain('keep going')
  })
})

describe('/usagecap', () => {
  test('reads what was typed', () => {
    expect(parseCapCommand('')).toEqual({ kind: 'show' })
    expect(parseCapCommand('5h 80')).toEqual({ kind: 'set', patch: { cap5h: 80 } })
    expect(parseCapCommand('week 60%')).toEqual({ kind: 'set', patch: { capWeek: 60 } })
    expect(parseCapCommand('5h off')).toEqual({ kind: 'set', patch: { cap5h: null } })
    expect(parseCapCommand('warn 8')).toEqual({ kind: 'set', patch: { warnAt: 8 } })
    expect(parseCapCommand('mode warn-only')).toEqual({ kind: 'set', patch: { onCap: 'warn-only' } })
    expect(parseCapCommand('off')).toEqual({ kind: 'off' })
    expect(parseCapCommand('override')).toEqual({ kind: 'override' })
    expect(parseCapCommand('reset')).toEqual({ kind: 'reset' })
    expect(parseCapCommand('5h 300').kind).toBe('help')
    expect(parseCapCommand('banana').kind).toBe('help')
  })

  test('describes the caps', () => {
    expect(describeCaps(NO_CAPS)).toContain('No usage caps')
    expect(describeCaps(CAPS)).toContain('5h cap 80%')
  })
})

describe('the cap on the limits row', () => {
  const model = (limits: BarModel['limits'], caps?: Caps): BarModel => ({
    tokens: ZERO,
    ctx: EMPTY_CTX,
    limits,
    session: EMPTY_SESSION,
    now: NOW,
    cwd: null,
    home: null,
    ...(caps ? { caps } : {}),
  })

  test('the marker sits at the cap and keeps the bar its width', () => {
    expect(capCell(80, 10)).toBe(8)
    expect(capCell(null, 10)).toBe(null)
    expect(capCell(100, 10)).toBe(null)
    const m = withCapMark('███', '░░░░░░░', 8)
    expect(m.filled + m.before + m.mark + m.after).toBe('███░░░░░▏░')
    expect(withCapMark('███', '░░░░░░░', null)).toEqual({ filled: '███', before: '░░░░░░░', mark: '', after: '' })
    // Already past the cap: no marker.
    expect(withCapMark('█████████', '░', 8).mark).toBe('')
  })

  test('no caps: the row is exactly as before', () => {
    const limits = toLimits(usageAt(34, 12).rateLimits)
    expect(rowsText([limitsLine(model(limits), 140)])).toEqual(rowsText([limitsLine(model(limits, NO_CAPS), 140)]))
  })

  test('a cap shows on its window, coloured by the stage', () => {
    const at = (p: number) => rowsText([limitsLine(model(toLimits(usageAt(p, 12).rateLimits), CAPS), 140)])[0] ?? ''
    expect(at(34)).toContain('▏')
    expect(at(34)).toContain('cap 80%')
    expect(at(78)).toContain('wrapping up')
    expect(at(81)).toContain('paused at cap 80%')
    // The weekly window has no cap here.
    expect(at(34).split('│')[1]?.includes('cap')).toBe(false)
  })

  test('narrow terminals still fit, keeping the cap once it matters', () => {
    const text = rowsText([limitsLine(model(toLimits(usageAt(81, 12).rateLimits), CAPS), 56)])[0] ?? ''
    expect(strWidth(text) <= 56).toBe(true)
    expect(text).toContain('paused at cap')
  })
})

// ---------------------------------------------------------------- in a session

describe('the cap in a session', () => {
  test('with no cap set, tool calls and prompts go through untouched', async ($, on) => {
    const w = world(on, usageAt(95))
    await start($)
    const res = await bash($)
    expect(res.deny).toBe(undefined)
    expect(res.context).toBe(undefined)
    await prompt($, 'hi')
    expect(w.prompts.at(-1)?.context).toBe(undefined)
    expect(w.toasts.length).toBe(0)
  })

  test('below the heads-up, nothing is said', { options: { cap5h: 80 } }, async ($, on) => {
    world(on, usageAt(50))
    await start($)
    expect((await bash($)).context).toBe(undefined)
  })

  test('heads-up: once per stage, beside the tool result', { options: { cap5h: 80 } }, async ($, on) => {
    world(on, usageAt(72))
    await start($)
    const first = await bash($)
    expect(first.deny).toBe(undefined)
    expect(first.context?.join('\n')).toContain('stopping point')
    expect((await bash($)).context).toBe(undefined)
    // The next stage is said again.
    await measure($, usageAt(78))
    expect((await bash($)).context?.join('\n')).toContain('Wrap up now')
  })

  test('each subagent gets its own note', { options: { cap5h: 80 } }, async ($, on) => {
    world(on, usageAt(72))
    await start($)
    expect((await bash($)).context?.length).toBe(1)
    expect((await bash($, 'agent-1')).context?.length).toBe(1)
    expect((await bash($, 'agent-1')).context).toBe(undefined)
  })

  test('at the cap: tool calls refused, one toast, never a cancelled turn', { options: { cap5h: 80 } }, async ($, on) => {
    const w = world(on, usageAt(70))
    await start($)
    await measure($, usageAt(81))
    const res = await bash($)
    expect(res.deny).toContain('Usage cap reached')
    expect(res.deny).toContain('handoff')
    expect((await bash($)).deny).toBeDefined()
    expect(w.toasts.length).toBe(1)
    expect(w.toasts[0]).toContain('80% cap')
  })

  test('warn-only at the cap: told, not refused', { options: { cap5h: 80, onCap: 'warn-only' } }, async ($, on) => {
    world(on, usageAt(85))
    await start($)
    const res = await bash($)
    expect(res.deny).toBe(undefined)
    expect(res.context?.join('\n')).toContain('Stop at the next safe point')
  })

  test('a prompt near the cap carries the note; it is never dropped', { options: { cap5h: 80 } }, async ($, on) => {
    const w = world(on, usageAt(85))
    await start($)
    const out = await prompt($, 'keep going')
    expect(out.drop).toBe(undefined)
    expect(w.prompts.at(-1)?.text).toBe('keep going')
    expect(w.prompts.at(-1)?.context?.join('\n')).toContain('cap is reached')
  })

  test('/usagecap sets, overrides and resets the cap', async ($, on) => {
    world(on, usageAt(85))
    await start($)
    expect((await usagecap($, '')).text).toContain('No usage caps')
    expect((await usagecap($, '5h 80')).text).toContain('5h cap 80%')
    expect((await bash($)).deny).toBeDefined()
    expect((await usagecap($, 'override')).text).toContain('Override on')
    const past = await bash($)
    expect(past.deny).toBe(undefined)
    expect(past.context?.join('\n')).toContain('keep going')
    expect((await usagecap($, 'reset')).text).toContain('No usage caps')
    expect((await bash($)).deny).toBe(undefined)
    expect((await usagecap($, 'banana')).text).toContain('Usage:')
  })

  test('the override ends when the window resets', async ($, on) => {
    const w = world(on, usageAt(85))
    await start($)
    await usagecap($, '5h 80')
    await usagecap($, 'override')
    expect((await bash($)).deny).toBe(undefined)
    await w.clock.advance(2 * H + 1000)
    // The new window reads 85% again: the old override no longer holds.
    await measure($, { ...usageAt(85), rateLimits: [{ kind: 'five_hour', percentUsed: 85, resetsAt: new Date(NOW + 7 * H).toISOString() }] })
    expect((await bash($)).deny).toBeDefined()
  })

  test('the caps outlast a new session: /usagecap saves them', async ($, on) => {
    world(on, usageAt(85))
    await start($)
    await usagecap($, '5h 80')
    await start($)
    expect((await bash($)).deny).toBeDefined()
  })

  test('the bar draws the cap under the prompt', { options: { cap5h: 80 } }, async ($, on) => {
    world(on, usageAt(78))
    await start($)
    const ui = await $.ui.mount({
      plugin: 'usagebar',
      surface: 'terminal',
      component: 'PromptHint',
      props: { isDraft: false, isWorking: false, hint: '? for shortcuts' },
      viewport: { columns: 160, rows: 40, isFullscreen: false },
    })
    expect(await ui.find({ type: 'Text', text: '▏' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'cap 80% · wrapping up' })).toBeDefined()
    await ui.unmount()
  })
})

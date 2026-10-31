import { describe, expect, mock, test } from 'claude-code/testing'
import type { Mounted } from 'claude-code/testing'
import type { On, SessionUsage } from 'claude-code'

import {
  ZERO,
  ctxLine,
  fmtSpan,
  limitLabel,
  limitsLine,
  effortParts,
  FRAME_MS,
  shimmerFrames,
  ultracodeParts,
  modelLabel,
  modelParts,
  parseEffortCommand,
  partsWidth,
  rowsText,
  settingsEffort,
  shownModel,
  strWidth,
  toLimits,
  truncateStart,
} from '../hooks/lib'
import type { BarModel } from '../hooks/lib'
import { EMPTY_CTX, EMPTY_SESSION } from '../hooks/lib'

const NOW = Date.parse('2026-10-28T10:00:00Z')
const H = 3_600_000

const USAGE: SessionUsage = {
  startedAt: NOW,
  context: {
    tokens: 40_000,
    window: 200_000,
    percent: 20,
    breakdown: {
      categories: [],
      totalTokens: 38_000,
      maxTokens: 200_000,
      rawMaxTokens: 200_000,
      autocompactSource: 'auto',
      percentage: 19,
      gridRows: [],
      model: 'claude-opus-5-5',
      memoryFiles: [],
      mcpTools: [],
      agents: [],
      autoCompactThreshold: 160_000,
      isAutoCompactEnabled: true,
      apiUsage: null,
    },
  },
  rateLimits: [
    { kind: 'seven_day', percentUsed: 12, resetsAt: new Date(NOW + 76 * H).toISOString() },
    { kind: 'five_hour', percentUsed: 34, resetsAt: new Date(NOW + 2 * H + 14 * 60_000).toISOString() },
  ],
  cost: { usd: 1.25 },
}

function world(on: On, usage: SessionUsage = USAGE, settings: Record<string, unknown> = {}) {
  const clock = mock.clock(on, { now: NOW })
  mock.store(on)
  on('ui.log', () => ({ value: undefined }))
  on('ui.invalidate', () => ({ value: undefined }))
  on('session.id', () => ({ value: 'sess-1' }))
  on('session.usage', () => ({ value: usage }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  on('session.cwd', () => ({ value: '/Users/me/projects/app' }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('settings.read', () => ({
    value: { effortLevel: 'medium', modelSettings: { 'claude-opus-5-5': { effortLevel: 'xhigh' } }, ...settings },
  }))
  on('command.run', () => ({ text: '' }))
  mock.env(on, { HOME: '/Users/me', CLAUDE_CONFIG_DIR: '/Users/me/.claude-2' })
  on('ui.render', { component: 'PromptHint' }, () => ({ type: 'Text', children: ['? for shortcuts'] }))
  return clock
}

const HINT_PROPS = { isDraft: false, isWorking: false, hint: '? for shortcuts' }
const model = (limits: BarModel['limits'], cwd: string | null = null, home: string | null = null): BarModel => ({
  tokens: ZERO,
  ctx: EMPTY_CTX,
  limits,
  session: EMPTY_SESSION,
  now: NOW,
  cwd,
  home,
})

describe('model and effort', () => {
  test('colours each effort level as the /effort picker does', () => {
    expect(effortParts('low')[0]?.color).toBe('warning')
    expect(effortParts('medium')[0]?.color).toBe('success')
    expect(effortParts('high')[0]?.color).toBe('permission')
    expect(effortParts('xhigh')[0]?.color).toBe('autoAccept')
    const max = effortParts('max')
    expect(max.map(p => p.text).join('')).toBe('max')
    expect(new Set(max.map(p => p.color)).size).toBe(3)
    expect(effortParts('32000')[0]?.dim).toBe(true)
  })

  test('reads what an /effort run set', () => {
    expect(parseEffortCommand('max', 'Set effort level to max (this session only): Maximum capability')).toEqual({ effort: 'max' })
    expect(parseEffortCommand('', 'Set effort level to xhigh (saved as your default for new sessions)')).toEqual({ effort: 'xhigh' })
    expect(parseEffortCommand('auto', 'Effort level reset')).toEqual({ effort: null })
    expect(parseEffortCommand('ultracode on', 'Ultracode on')).toEqual({ ultracode: true })
    expect(parseEffortCommand('ultracode off', '')).toEqual({ ultracode: false })
    expect(parseEffortCommand('max', '')).toEqual({ effort: 'max' })
    expect(parseEffortCommand('status', '')).toEqual({})
    expect(parseEffortCommand('', 'Cancelled')).toEqual({})
  })

  test('ultracode follows the effort when on', () => {
    const on = modelParts('claude-opus-5-5', 'max', true)
    expect(on.map(p => p.text).join('')).toBe('✻ Opus 5.5 · max · ultracode')
    expect(on.at(-1)?.color).toBe('autoAccept')
    expect(modelParts('claude-opus-5-5', 'max').map(p => p.text).join('')).toBe('✻ Opus 5.5 · max')
  })

  test('names the model', () => {
    expect(modelLabel('claude-opus-5-5')).toBe('Opus 5.5')
    expect(modelLabel('claude-opus-5-5[1m]')).toBe('Opus 5.5 (1M)')
    expect(modelLabel('claude-fable-5-1')).toBe('Fable 5.1')
    expect(modelLabel('claude-sonnet-5')).toBe('Sonnet 5')
    expect(modelLabel('opus')).toBe('Opus')
  })

  test('reads the effort from the model\'s settings, else the top level', () => {
    const ms = { 'claude-opus-5-5': { effortLevel: 'xhigh' } }
    expect(settingsEffort(ms, 'high', 'claude-opus-5-5')).toBe('xhigh')
    expect(settingsEffort(ms, 'high', 'claude-opus-5-5[1m]')).toBe('xhigh')
    expect(settingsEffort(ms, 'high', 'claude-sonnet-5-5')).toBe('high')
    expect(settingsEffort(undefined, undefined, 'x')).toBe(null)
  })

  test('the last request stands until /model or /effort changes', () => {
    const seen = { model: 'claude-opus-5-5', sessionModel: 'opus', effort: 'max', settingsEffort: 'high' }
    expect(shownModel(seen, 'opus', () => 'high')).toEqual({ model: 'claude-opus-5-5', effort: 'max' })
    expect(shownModel(seen, 'opus', () => 'low')).toEqual({ model: 'claude-opus-5-5', effort: 'low' })
    expect(shownModel(seen, 'sonnet', () => 'medium')).toEqual({ model: 'sonnet', effort: 'medium' })
    expect(shownModel(null, 'claude-opus-5-5', () => null)).toEqual({ model: 'claude-opus-5-5', effort: null })
  })
})

describe('Claude\'s home on the limits row', () => {
  test('sits flush right with the house icon', () => {
    const { right } = limitsLine(model([], null, '/Users/me/.claude-2'), 140)
    expect(right.at(-1)?.text).toBe('/Users/me/.claude-2')
    expect(right.at(-1)?.color).toBe('claude')
    expect(right.at(0)?.text).toBe('⌂ ')
  })
})

describe('the cwd on the ctx row', () => {
  test('sits flush with the row end in the claude accent', () => {
    const { right } = ctxLine(model([], '/Users/me/projects/app'), 140)
    expect(right.at(-1)?.text).toBe('/Users/me/projects/app')
    expect(right.at(-1)?.color).toBe('claude')
    expect(right.at(0)?.text).toBe('CWD: ')
    expect(right.at(0)?.dim).toBe(true)
  })

  test('keeps the last folders when tight, and steps aside when there is no room', () => {
    const long = '/Users/me/IdeaProjects/some-very-long-project-name/modules/feature'
    const tight = ctxLine(model([], long), 100)
    expect(partsWidth(tight.left) + 3 + partsWidth(tight.right) <= 100).toBe(true)
    expect(tight.right.at(-1)?.text.startsWith('…')).toBe(true)
    expect(tight.right.at(-1)?.text.endsWith('/modules/feature')).toBe(true)
    expect(ctxLine(model([], long), 40).right.length).toBe(0)
  })

  test('truncateStart', () => {
    expect(truncateStart('/a/b/c', 10)).toBe('/a/b/c')
    expect(truncateStart('/abc/def/ghi', 6)).toBe('…f/ghi')
  })
})

describe('lib', () => {
  test('orders the windows 5h, week, then the rest', () => {
    const l = toLimits([
      { kind: 'spend_limit', percentUsed: 3 },
      { kind: 'seven_day', percentUsed: 12 },
      { kind: 'five_hour', percentUsed: 34, resetsAt: 'not a date' },
    ])
    expect(l.map(x => x.kind).join(',')).toBe('five_hour,seven_day,spend_limit')
    expect(l[0]?.resetsAt).toBe(null)
  })

  test('names and spans', () => {
    expect(limitLabel('five_hour')).toBe('5h')
    expect(limitLabel('seven_day_opus')).toBe('week opus')
    expect(fmtSpan(30_000)).toBe('<1m')
    expect(fmtSpan(2 * H + 14 * 60_000)).toBe('2h 14m')
    expect(fmtSpan(76 * H)).toBe('3d 4h')
  })

  test('a window past its reset reads reset', () => {
    const text = rowsText([limitsLine(model([{ kind: 'five_hour', percentUsed: 90, resetsAt: NOW - 1000 }]), 120)])[0]
    expect(text?.includes('reset')).toBe(true)
    expect(text?.includes('90%')).toBe(false)
  })

  test('no reading yet', () => {
    expect(rowsText([limitsLine(model([]), 120)])[0]?.includes('no reading yet')).toBe(true)
  })

  test('narrow terminals drop the extras and fit', () => {
    const limits = toLimits(USAGE.rateLimits)
    const text = rowsText([limitsLine(model(limits), 56)])[0] ?? ''
    expect(strWidth(text) <= 56).toBe(true)
    expect(text.includes('34%')).toBe(true)
    expect(text.includes('12%')).toBe(true)
  })
})

describe('the shimmer', () => {
  test('frames: xhigh sweeps past both ends, max turns once round, ultracode sweeps in', () => {
    expect(shimmerFrames('xhigh', false)).toBe(9)
    expect(shimmerFrames('max', false)).toBe(7)
    expect(shimmerFrames(null, true)).toBe(11)
    expect(shimmerFrames('high', false)).toBe(0)
    expect(effortParts('xhigh', 2)[2]?.color).toBe('#d0b4ff')
    expect(effortParts('xhigh', 9)).toEqual(effortParts('xhigh'))
    expect(effortParts('max', 1)[0]?.color).toBe(effortParts('max')[1]?.color)
    expect(effortParts('max', 7)).toEqual(effortParts('max'))
    expect(ultracodeParts(0).some(p => p.color === '#d0b4ff')).toBe(false)
    expect(ultracodeParts(1)[0]?.color).toBe('#d0b4ff')
    expect(ultracodeParts(11)).toEqual(ultracodeParts())
  })

  const PROMPT = {
    plugin: 'usagebar',
    surface: 'terminal',
    component: 'PromptHint',
    props: HINT_PROPS,
    viewport: { columns: 160, rows: 40, isFullscreen: false },
  } as const
  const colorsOf = async (ui: Mounted<'terminal', 'PromptHint'>) =>
    (await ui.findAll({ type: 'Text' })).filter(t => t.text.length === 1 && /[max]/.test(t.text)).map(t => String(t.props.color))

  test('runs once after /effort max, then stands still', async ($, on) => {
    const clock = world(on)
    await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
    await $.command.run({ command: 'effort', args: 'max', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 160 } })
    const ui = await $.ui.mount(PROMPT)
    const first = await colorsOf(ui)
    await clock.advance(FRAME_MS)
    const ui2 = await $.ui.mount(PROMPT)
    expect((await colorsOf(ui2)).join()).not.toBe(first.join())
    await clock.advance(FRAME_MS * 10)
    const done = await $.ui.mount(PROMPT)
    const still = await colorsOf(done)
    await clock.advance(FRAME_MS * 3)
    const later = await $.ui.mount(PROMPT)
    expect((await colorsOf(later)).join()).toBe(still.join())
    expect(still.join()).toBe(effortParts('max').map(p => p.color).join())
    for (const u of [ui, ui2, done, later]) await u.unmount()
  })

  test('reduced motion: no shimmer', async ($, on) => {
    const clock = world(on, USAGE, { prefersReducedMotion: true })
    await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
    await $.command.run({ command: 'effort', args: 'max', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 160 } })
    const ui = await $.ui.mount(PROMPT)
    expect((await colorsOf(ui)).join()).toBe(effortParts('max').map(p => p.color).join())
    await clock.advance(FRAME_MS)
    const ui2 = await $.ui.mount(PROMPT)
    expect((await colorsOf(ui2)).join()).toBe(effortParts('max').map(p => p.color).join())
    await ui.unmount()
    await ui2.unmount()
  })
})

describe('under the prompt', () => {
  test('draws the ctx row and the limits row beneath the engine line', async ($, on) => {
    world(on)
    await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
    const ui = await $.ui.mount({
      plugin: 'usagebar',
      surface: 'terminal',
      component: 'PromptHint',
      props: HINT_PROPS,
      viewport: { columns: 160, rows: 40, isFullscreen: false },
    })
    expect(await ui.find({ type: 'Text', text: '? for shortcuts' })).toBeDefined()
    // 40k used of the 160k auto-compact threshold
    expect(await ui.find({ type: 'Text', text: ' 25%' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '120k' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '$1.25' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: ' 34%' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: ' 12%' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '2h 14m' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '3d 4h' })).toBeDefined()
    const rows = (await ui.findAll({ type: 'Text' })).filter(t => t.props.wrap === 'truncate-end')
    // The model pinned over the engine's line, then the two rows, each padded to the footer's width.
    expect(rows.length).toBe(3)
    expect(rows.map(r => r.text.split(' ')[0]).join('|')).toBe('ctx|5h|✻')
    expect(rows[2]?.text).toBe('✻ Opus 5.5 · xhigh')
    expect(strWidth(rows[0]?.text ?? '')).toBe(156)
    expect(rows[0]?.text.endsWith('CWD: /Users/me/projects/app')).toBe(true)
    expect(strWidth(rows[1]?.text ?? '')).toBe(156)
    expect(rows[1]?.text.endsWith('⌂ /Users/me/.claude-2')).toBe(true)
    await ui.unmount()
  })

  test('mode labels at the footer\'s right end narrow the rows', async ($, on) => {
    world(on)
    on('ui.render', { component: 'SessionMode' }, () => ({ type: 'Text', children: ['focus'] }))
    await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
    const modes = await $.ui.mount({ plugin: 'usagebar', surface: 'terminal', component: 'SessionMode', props: { modes: ['focus'] } })
    expect(await modes.find({ type: 'Text', text: 'focus' })).toBeDefined()
    const ui = await $.ui.mount({
      plugin: 'usagebar',
      surface: 'terminal',
      component: 'PromptHint',
      props: HINT_PROPS,
      viewport: { columns: 160, rows: 40, isFullscreen: false },
    })
    const rows = (await ui.findAll({ type: 'Text' })).filter(t => t.props.wrap === 'truncate-end')
    expect(strWidth(rows[0]?.text ?? '')).toBe(156 - 7)
    await ui.unmount()
    await modes.unmount()
  })

  test('a measurement moves the limits row', async ($, on) => {
    world(on)
    await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
    await $.session.measure({
      context: USAGE.context,
      rateLimits: [{ kind: 'five_hour', percentUsed: 91, resetsAt: new Date(NOW + 20 * 60_000).toISOString() }],
      changed: ['rateLimits'],
    })
    const ui = await $.ui.mount({
      plugin: 'usagebar',
      surface: 'terminal',
      component: 'PromptHint',
      props: HINT_PROPS,
      viewport: { columns: 160, rows: 40, isFullscreen: false },
    })
    expect(await ui.find({ type: 'Text', text: ' 91%' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '20m' })).toBeDefined()
    await ui.unmount()
  })
})

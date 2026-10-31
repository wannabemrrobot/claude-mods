/** Token counts summed over the API responses a bucket saw. */
export type BarTokens = {
  /** Uncached input. */
  input: number
  cacheRead: number
  cacheWrite: number
  output: number
  requests: number
}

export type BarContext = {
  /** The live fill as the last main response reported it. */
  tokens: number | null
  window: number | null
  /** Where auto-compaction runs; null when off or not read yet. */
  threshold: number | null
  isAutoCompact: boolean
  /** /context's local estimate, shown until a response reports the fill. */
  estimate: number | null
  /** The fill after each recent main turn: the pace "≈ turns" reads. */
  history: number[]
}

/** One rate-limit window as the last API response reported it. */
export type BarLimit = {
  /** `five_hour`, `seven_day`, or a gateway's `spend_limit`. */
  kind: string
  percentUsed: number
  /** When the window resets, in ms since the epoch; null when not reported. */
  resetsAt: number | null
}

export type BarSession = { costUsd: number | null }

/** What the last main-thread request ran on. */
export type BarSeen = {
  /** The model the request named, as the engine resolved it (a full id). */
  model: string
  /** `$.session.model()` at the time: what tells a later /model switch. */
  sessionModel: string
  /** The effort the request sent; null for a model without effort. */
  effort: string | null
  /** The settings' effort for that model at the time: a later change outranks `effort`. */
  settingsEffort: string | null
}

declare module 'claude-code' {
  interface PluginState {
    usagebar: {
      tokens: BarTokens
      ctx: BarContext
      limits: BarLimit[]
      session: BarSession
      seen: BarSeen | null
      /** Ultracode as the last `/effort ultracode on|off` set it this session; null: the settings' say. */
      ultracode: boolean | null
    }
  }
}

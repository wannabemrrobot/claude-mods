# usagebar

A Claude Code mod that draws two rows under the prompt in the terminal, and adds to the line above them.

![usagebar under the prompt: context bar, tokens and cost, 5-hour and weekly limits, model and effort](screenshots/hero.svg)

## What it shows

- **The engine's line** (`auto mode on`, shortcuts): the current model and its effort at the right end, `✻ Opus 5.5 · xhigh`, coloured as the `/effort` picker colours them. It follows `/model` and `/effort`. A change to `xhigh` or `max`, or ultracode turning on, plays one short shimmer, then stands still (none with `prefersReducedMotion`).
- **ctx**: how full the context is compared with the auto-compact threshold, the tokens left before compaction, roughly how many turns that leaves at the recent pace, tokens in/out/total, the cache share and the session's cost, with `CWD:` and the session's directory at the right end.
- **limits**: one bar for each rate-limit window the API reports (5-hour, weekly, and any per-model weekly or spend limit), with how long until it resets and the local time it resets at, with ⌂ and Claude's config folder (`CLAUDE_CONFIG_DIR`, else `~/.claude`) at the right end.

The limits come from the last API response, so they update after each reply and show "no reading yet" before the first one. The reset countdowns refresh every 30 seconds. On narrow terminals the extras drop out first so the bars always fit.

## Screenshots

**Colours follow the pressure.** Bars go green, then amber from 60%, then red from 85%, for the context and for every limit window, including per-model weekly limits when the API reports them.

![Near the limits: context at 91% with one turn left before compaction, 5-hour window at 91%, weekly at 64%, max effort and ultracode on](screenshots/pressure.svg)

**Effort changes shimmer once.** Switching to `xhigh` or `max`, or turning ultracode on, plays one short pass in the colours the `/effort` picker uses, then stands still.

![The xhigh label sweeping once after /effort xhigh](screenshots/shimmer.svg)

**Before the first reply.** The context fill is an estimate (`~`) until a response reports it, and the limits wait for their first reading.

![A fresh session: estimated context fill and no limits reading yet](screenshots/fresh.svg)

**Narrow terminals.** Lower-priority pieces drop out first (turns left, the reset clock, the paths), and token counts switch to `↑ ↓ Σ`.

![usagebar in a 96-column terminal](screenshots/narrow.svg)

## Usage caps

Set a cap on the 5-hour or weekly window and the agent winds down as usage nears it, instead of running the window dry. With a 5-hour cap of 80%:

| Usage | What the agent is told | The bar |
| --- | --- | --- |
| 70% (cap − 10) | heads-up: aim for a stopping point, start nothing large | `▏` marker, `cap 80%` in amber |
| 77% (cap − 3) | wrap up: finish the step, leave things working, write a handoff (done, next, open), stop | `cap 80% · wrapping up` |
| 80% | tool calls are refused with the same ask, so it writes the handoff and ends the turn | `paused at cap 80%`, one toast |

- The notes reach the model beside a tool result (and beside a prompt you type), once per stage, for the main agent and each subagent. You never see them; they don't touch the system prompt, so the prompt cache stays warm.
- No turn is ever cancelled, and no prompt is dropped. `warn-only` mode only tells the agent and never refuses a tool.
- Usage is read from the last API reply, so a stage can begin about one request late; the wrap-up starts early to leave room.
- The windows are your account's, so a cap counts every session on the account. Caps need a Pro or Max login: API-key sessions get no 5-hour or weekly figures.

Set them in `/config` (`cap5h`, `capWeek`, `warnAt`, `wrapAt`, `onCap`; 0 is no cap), or from the prompt:

```
/usagecap                 show the caps
/usagecap 5h 80           cap the 5-hour window at 80%
/usagecap week 60         cap the weekly window at 60% (every weekly window)
/usagecap 5h off          remove one cap; /usagecap off removes both
/usagecap warn 10         heads-up this many points below a cap (wrap 3 for the wrap-up)
/usagecap mode warn-only  only tell the agent (or: wind-down, the default)
/usagecap override        keep going past the cap until that window resets
/usagecap reset           drop what /usagecap set and go back to /config
```

What `/usagecap` sets is saved and holds in later sessions, over `/config`'s values.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install usagebar --marketplace wannabemrrobot/claude-mods
```

Answer `y` to add the marketplace, then pick a scope. The footer shows up right away.

From a shell:

```
claude plugin install usagebar --marketplace wannabemrrobot/claude-mods
```

In the desktop app, where `/plugin` doesn't run: click **+** next to the prompt box → **Plugins** → **Add marketplace** with `wannabemrrobot/claude-mods` → **Add plugin**.

## Develop

Run it from a clone with `claude --plugin-dir /path/to/claude-mods/usagebar`.

`claude plugin validate .` · `claude plugin test .`

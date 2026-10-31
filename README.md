# claude-mods

A directory of mods for [Claude Code](https://claude.com/claude-code). Each folder is one mod: a small hooks module that changes how Claude Code looks or behaves. This repository is also a plugin marketplace, so any mod in it installs with one line.

## Mods

| Mod | What it does |
| --- | --- |
| [usagebar](./usagebar) | Two rows under the prompt: context left until auto-compact, tokens in/out/total, cache share and cost, plus every rate-limit window with its reset. The current model and effort sit at the right end of the line above. |

## Install a mod

At the prompt of a Claude Code terminal session:

```
/plugin install <mod> --marketplace wannabemrrobot/claude-mods
```

Answer `y` to add the marketplace, then pick a scope (user scope loads it in every session).

From a shell:

```
claude plugin install <mod> --marketplace wannabemrrobot/claude-mods
```

In the desktop app, where `/plugin` doesn't run: click **+** next to the prompt box → **Plugins** → **Add marketplace** with `wannabemrrobot/claude-mods` → **Add plugin**.

## Layout

```
.claude-plugin/marketplace.json   lists every mod in this repo
<mod>/
  .claude-plugin/plugin.json      the mod's manifest
  hooks/hooks.json                points at the hooks module
  hooks/register.tsx              the mod itself
  types/index.d.ts                its state contract, where it keeps state
  tests/                          `claude plugin test <mod>`
```

## Adding a mod

1. Add a folder with the layout above.
2. Add an entry to `.claude-plugin/marketplace.json` with `"source": "./<mod>"`.
3. Check it: `claude plugin validate <mod>` and `claude plugin test <mod>`.
4. Add a row to the table above.

## License

[MIT](./LICENSE)

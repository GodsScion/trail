# trail

Browser tools for AI coding agents, with a self-healing workflow layer.

MIT licensed. Runs locally. No backend, no account, no telemetry.

## What makes this different

Browser automation for agents is a solved and crowded problem — Playwright MCP,
chrome-devtools-mcp, browser-use and others all ship good, free, token-efficient
page snapshots. `trail` does not try to win on that.

The bet here is that **primitives are commodity and encoded site knowledge is
not.** How a given site's multi-step wizard actually behaves, which of its fields
are custom, where it hides the button you need — that compounds with every
contributor, and no browser vendor will build it.

So the unit of value is a **workflow**: a markdown file with natural-language
steps and machine-written selector hints inline. Anything an agent does more than
once on a site it has seen before is a candidate — QA-ing your own frontend after
a change, pulling structured data out of a dashboard, filling a long form, or
walking a checkout.

The example below is a job application because that is a form long enough to make
the economics obvious, not because the tool is job-specific.

```markdown
---
name: apply-greenhouse
match: "boards.greenhouse.io/*/jobs/*"
confirm_submit: true
rate_limit: 10/hour
---

## Intent
Apply to a Greenhouse job. Never submit without confirmation.

## Steps
1. Click Apply
   <!-- hint: role=link[name="Apply for this job"] -->
2. Upload resume from $RESUME
   <!-- hint: role=button[name="Attach"] -->
```

### Why hints are ARIA locators, not CSS

Class names are hashed garbage under Tailwind and CSS-in-JS, so a CSS hint dies
on the next deploy. `role=button[name="Apply"]` is semantic: it survives
restyling and DOM restructuring, because changing it usually means changing what
the page says to a screen reader.

### Where the token savings actually come from

Not from tiered snapshot verbosity. From **not looking at the page at all when a
hint hits**:

```
click({ hint: 'role=button[name="Apply"]', intent: 'Apply button' })

  HIT  -> clicks, returns "ok". No snapshot fetched.        ~20 tokens
  MISS -> returns a scoped snapshot; the agent picks the right element,
          passes learned_hint, and the corrected hint is written back
          to the workflow file.
```

Because every miss rewrites the hint, **workflows heal instead of rotting.**
That is what makes a shared library viable rather than a graveyard of broken
files.

## Install

Requires Node 20+ and Google Chrome installed.

```bash
git clone <your-fork> trail && cd trail
npm install
npm run build
```

### Claude Code

```json
{
  "mcpServers": {
    "trail": {
      "command": "node",
      "args": ["/absolute/path/to/trail/dist/server.js"],
      "env": { "TRAIL_WORKFLOWS": "/absolute/path/to/your/workflows" }
    }
  }
}
```

First run opens a real Chrome window against a dedicated profile. Log into the
sites you care about once; the session persists.

## The twelve tools

Deliberately twelve. Tool definitions occupy context on every agent turn — a
small surface is a feature, not an omission.

| Group | Tools |
|---|---|
| Observe | `browser_snapshot` `browser_screenshot` |
| Navigate | `browser_navigate` `browser_wait` |
| Act | `browser_click` `browser_type` `browser_select` `browser_upload` `browser_press` `browser_scroll` `browser_drag` |
| Workflow | `workflow_load` |

## Safety

These are core behaviours, not settings:

- **Submit confirmation is default-on.** Submit-like elements refuse to fire
  without an explicit `confirm: true`.
- **Per-domain rate limits**, enforced by the server rather than left to agent
  judgement.
- **Jittered, human-paced input.** No instant fills.
- **Block detection** stops and hands off to a human instead of half-completing
  a flow.

Every one of these is **tunable per workflow** — `confirm_submit: false` and an
absent `rate_limit` opt out — but all of them default to the cautious setting,
and an absent key parses to the safe value rather than the permissive one.

The reasoning: when automating an authenticated site, the largest real risk is
usually not fingerprinting but account-level throttling or suspension from
behavioural volume. Losing the account is generally worse than the task going
unfinished, so the defaults are conservative and you opt into speed deliberately.

## Why real Chrome, not bundled Chromium

Playwright's bundled Chromium has a JA3 TLS fingerprint matching no real Chrome
release, so it is blocked at the handshake before any JavaScript runs. `trail`
drives your installed Chrome via `channel: "chrome"` on
[Patchright](https://github.com/Kaliiiiiiiiii-Vinyzu/patchright), which also
patches the `Runtime.enable` CDP leak — currently the most reliable
bot-detection signal there is.

Verified on this stack: `navigator.webdriver === false`, and file uploads fire
change events with `isTrusted=true`.

## Development

```bash
npm test              # unit suite; browser tests skip by default
TRAIL_E2E=1 npm test  # include tests that drive real Chrome
npm run typecheck
npm run typecheck:tests
npm run test:e2e      # the four success criteria
```

[`tests/e2e/criteria.test.ts`](tests/e2e/criteria.test.ts) is the executable
spec: it measures the cold-vs-warm token ratio and exercises the self-healing
path against real Chrome.

## Status

Early. The tool surface and workflow format are settled; the workflow library is
not yet a thing that exists. Contributions of workflows are more valuable than
contributions of code.

`trail` is general-purpose agent browser tooling. It is a separate project from
[Auto_job_applier_linkedIn](https://github.com/GodsScion/Auto_job_applier_linkedIn),
which remains the standalone consumer tool for job applications.

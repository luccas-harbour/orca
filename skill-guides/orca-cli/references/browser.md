# Built-in browser commands

Use a snapshot-interact-re-snapshot loop:

```text
ORCA goto --url https://example.com --json
ORCA snapshot --json
ORCA click --element @e3 --json
ORCA snapshot --json
```

Common commands:

```text
ORCA goto --url <url> --json
ORCA back --json
ORCA reload --json
ORCA snapshot --json
ORCA screenshot --json
ORCA full-screenshot --json
ORCA pdf --json
ORCA click --element <ref> --json
ORCA fill --element <ref> --value <text> --json
ORCA type --input <text> --json
ORCA select --element <ref> --value <value> --json
ORCA check --element <ref> --json
ORCA scroll --direction down --amount 1000 --json
ORCA hover --element <ref> --json
ORCA focus --element <ref> --json
ORCA keypress --key Enter --json
ORCA mouse move --x 100 --y 200 --json
ORCA mouse down --button left --json
ORCA mouse up --button left --json
ORCA mouse wheel --dy 500 --json
ORCA upload --element <ref> --files <paths> --json
ORCA wait --text <text> --json
ORCA wait --url <substring> --json
ORCA wait --selector <css> --json
ORCA wait --load networkidle --json
ORCA eval --expression <js> --json
ORCA tab list --json
ORCA tab create --url <url> --json
ORCA tab switch --index <n> --json
ORCA tab close --index <n> --json
ORCA cookie get --json
ORCA capture start --json
ORCA console --limit 50 --json
ORCA network --limit 50 --json
ORCA exec --help
```

Browser rules:

- Use `ORCA <command> --help` to discover syntax, such as `ORCA mouse move --help`.
- Re-snapshot after navigation, tab switches, clicks that change the page, and any `browser_stale_ref`.
- Refs like `@e1` are assigned by `snapshot`, scoped to one tab, and invalidated by navigation or tab switch.
- Browser commands default to the current worktree and its active tab. Use `--worktree all` only intentionally.
- For concurrent browser work, run `ORCA tab list --json`, read `tabs[].browserPageId`, and pass `--page <browserPageId>` on later commands.
- Use `--page` to work with inactive tabs; desktop activation is not required.
- Use typed tab commands (`ORCA tab list/create/close/switch`), not `ORCA exec --command "tab ..."`, so Orca keeps UI state synchronized.
- Prefer `wait --text`, `--url`, `--selector`, or `--load` after async page changes instead of bare timeouts.
- Page evaluations have a 30-second deadline including queue time. Keep readiness probes short; use condition waits for longer loading operations.
- Return small, serializable state fields from evaluations instead of editor, session, or collaboration objects. Check that page APIs exist before calling them.
- After a dev-server reload, reacquire editor handles and snapshot refs. Finish fixture generation and dependency optimization before opening the page when possible.
- An input command's success receipt confirms dispatch. Verify the expected selection, content, or DOM event before treating the interaction as complete.
- Anything not listed above goes through `ORCA exec --command "<agent-browser command>"`.
- If `fill` or `type` fails on a custom input, try `ORCA focus --element @e1 --json` then `ORCA inserttext --text "text" --json`.
- A client-hosted page renders in the paired desktop's browser engine, so every command against it needs that desktop online and returns `browser_host_unavailable` while it is closed, asleep, or disconnected. Server-hosted pages run with no desktop attached; prefer them for long or unattended automation.

Common recoveries:

- `browser_no_tab`: open a tab with `ORCA tab create --url <url> --json`.
- `browser_stale_ref`: run `ORCA snapshot --json` and retry with fresh refs.
- `browser_tab_changed`: the page's guest changed during the command; run `ORCA snapshot --json` and verify the page state before retrying.
- `browser_tab_not_found`: run `ORCA tab list --json` before switching or closing.
- `browser_host_unavailable`: the desktop hosting the page is offline. Bring it back, or recreate the page with server placement if the work must outlive the desktop session.

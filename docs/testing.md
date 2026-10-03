# Testing

Offline checks use Node's test runner and TypeScript:

```bash
npm test
npm run check
```

`npm run check` is the extension and adapter check. `pi --version` only shows that the CLI boots. GitHub Actions runs `npm ci`, `npm run typecheck`, and `npm test` on Node 22.23.2 with no secrets.

## What the tests cover

- Client credentials stay inside the selected client's frozen config.
- The active client reaches the prompt, and untrusted page text cannot authorize a write.
- Missing, denied, and stale approvals fail closed.
- Notion reads report `complete` or `partial`, and a truncated read is not complete.
- Asana REST serializes task fields and rejects a project outside the selected workspace.
- HubSpot decisions cover direct, proxy, scripted, and cached-grant requests. Unknown tools and deletes are denied.
- Receipt replay skips a succeeded or uncertain target.
- Review mode blocks edit, write, and shell tool names.

## Live checks

Live Notion, Asana, and HubSpot calls stay skipped until credentials exist locally. Do not treat `smoke:hubspot`, `smoke:client`, or a Cursor MCP session as a live Pi pass. `npm run smoke:hubspot:live` prints `status: SKIPPED`.

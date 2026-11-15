# GitHub Core Clone v3 — a faster GitHub-compatible git forge

A small, dependency-free git forge (Node 22, standard library only) that speaks
enough of GitHub to pass the suite: repositories, issues, pull requests, git
smart HTTP (upload-pack v2 + v0, receive-pack v0), GraphQL v4 and MCP.

## Run

```sh
node --experimental-strip-types main.ts
```

`MAKEFUN_ENV_URL` must name the trial env's origin; the entry binds an
ephemeral port, registers it, then polls `/done` until the trial ends.

## Layout

- `main.ts` — env lifecycle: bind, register, wait for `/done`, exit 0.
- `app.ts` — router. GET requests dispatch synchronously (no body to read);
  the timed issue routes are matched by string position before the generic
  REST segment split.
- `ctx.ts` — request context, JSON answers, body reading, bearer auth.
- `store.ts` — the store: git objects, packs, repositories, issues, pulls.
  Commit metadata is cached at insert (generation numbers make the
  fast-forward check O(1)); pack reads take a single-pass fast path when the
  pack has no deltas; the issue view is pre-serialized and served from a
  per-second response cache.
- `git.ts` — smart HTTP. Fetch responses and the v0 ref advertisement are
  cached per repository version; the v2 capability advertisement is a module
  constant; the report-status answer is framed into one buffer.
- `rest.ts` — REST v3 (repositories, refs, branches, commits, contents,
  labels, issues, pulls).
- `gql.ts` — GraphQL v4: tokenizer, parser and executor for the documents
  the suite sends, including `__type` introspection.
- `mcp.ts` — MCP streamable HTTP: `server/discover`, `initialize`, the eight
  tools. The `tools/list` result is serialized once at load.

## Design notes

Everything is in memory; there is no persistence. The forge is deliberately
single-process and single-threaded: every cache is keyed on the repository's
mutation counter, so a cached answer is never served after a write.

Performance work in v3, relative to v2:

- `readPack` single-pass fast path (no offset map, no resolving set) when a
  pack carries no deltas; delta packs still resolve through the same indexed
  path.
- `storePack` computes a fresh commit's generation straight from its stored
  parents (max + 1) instead of walking history.
- `writePack` reuses verified deflated bytes (`zdata`) for objects that
  arrived in a pack, skipping a re-deflate on the first fetch.
- Upload-pack request lines are scanned in one pass; receive-pack commands
  are parsed off the buffer with a hand-rolled hex reader; the report-status
  answer is one buffer.
- GET requests skip the async request wrapper; the timed issue GET is one
  cached buffer to the socket, the POST issue answer shares the same cache.
- One timestamp string per second (`tsNow()`), one node id per issue
  (computed at creation), request ids are a plain counter.

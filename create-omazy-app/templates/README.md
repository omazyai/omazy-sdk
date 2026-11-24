# %%title%%

An AI product on the [Omazy SDK](https://docs.omazy.ai/build-on-omazy/) kits, made by
`create-omazy-app` %%version%%. It is a Cloudflare Worker with an MCP door that Claude, ChatGPT,
Cursor and Claude Code can call, and every call goes through the guard.

## What is here

| Path | What it is |
|---|---|
| `src/capabilities.ts` | The actions the product offers, defined once: `note_get` (R0, a read) and `note_add` (R2, a write the person confirms from its preview) |
| `src/guard.ts` | The guard: switches, tenant checks, `can()`, confirm tokens and the request log, on D1 |
| `src/access.ts` | Who may do what. `can()` runs on every call |
| `src/door.ts` | The MCP door at `/mcp`, built from the registry |
| `src/keys.ts` | Personal keys: one person's seat at the door, at most R2 and 90 days |
| `src/notes.ts` | The product's own data, in D1 |
//#if ai
| `src/ai.ts` | The `note_title` task unit, its prompt and its eval set: 30 cases in `evals/note-title.jsonl` (threshold 0.9) |
//#endif
//#if actor
| `src/actor.ts` | The `note_intake` actor: a conversation that ends in a card for `note_add` |
//#endif
//#if flow
| `src/flow.ts` | The `note_followup` workflow on Cloudflare Workflows, started by `note_followup_start` |
//#endif
//#if copilot
| `src/copilot.ts`, `src/page.ts` | The copilot and its page at `/`, with consent cards, standing grants and approvals |
//#endif
//#if oauth
| `src/oauth.ts` | OAuth for clients that sign in. Off; read [OAuth](#oauth) first |
//#endif
| `src/app.ts`, `src/index.ts` | The wiring, and the Worker |
| `migrations/` | The product's tables, then each kit's |
| `test/` | Parity, the tier snapshot, approvals, tenant isolation, the door, and the injection suite |

## Run it locally

```sh
npm install
npm run migrate                                   # the tables, in local D1
npm run key -- --person you --tenant demo         # prints a personal key once
npm run dev                                       # http://localhost:8787
```

`.dev.vars` holds the local secrets and turns the door on for `wrangler dev`. It is not committed.

List the tools and add a note, with the key in `KEY`:

```sh
KEY=$(npm run --silent key -- --person you --tenant demo)
mcp() { curl -s localhost:8787/mcp -H "authorization: Bearer $KEY" -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' -H 'mcp-protocol-version: 2025-06-18' -d "$1"; echo; }

mcp '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
mcp '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"note_add","arguments":{"title":"Call the plumber"}}}'
```

The first `note_add` does not add anything: it answers with the preview and a `token` (in
`structuredContent` and `_meta["ai.omazy/outcome"]`, named as `guard.call` names them). Call it
again with the same arguments and `"confirm_token": "<token>"` and the note is added. That is
the guard's confirm for an R2 write; a client shows the person the preview in between.

## Test

```sh
npm run check      # typecheck and tests
```

The first run writes `catalog.snapshot.json`. Commit it: from then on a changed tier or a
breaking schema change fails until you update the snapshot on purpose
(`OMAZY_UPDATE_SNAPSHOTS=1 npm test`).

## Deploy

```sh
npx wrangler login
npm run setup
```

`setup` builds the page when the product has one, creates the D1 database and the KV namespace on
your Cloudflare account, writes their ids into `wrangler.jsonc`, applies the migrations, deploys
and sets `GUARD_SECRET`. It prints the
Worker's URL. Run it again safely; after that, `npm run deploy` ships changes and
`npm run migrate:remote` applies new migrations.

The door starts **off** in production: it answers 503 until you turn it on. Mint a key on the
deployed Worker, then open the door:

```sh
npm run key -- --person you --tenant demo --remote
npm run door -- on --remote
```

Call it over HTTPS as above, with your Worker's URL in place of `localhost:8787`. To connect
Claude Code:

```sh
claude mcp add --transport http %%name%% https://%%name%%.<your-subdomain>.workers.dev/mcp --header "Authorization: Bearer $KEY"
```

`npm run door -- off --remote` stops every request within a few seconds, whatever the client.

### Approval codes

Whoever decides an approval proves it is them with a one-time code (the guard's `codeStepUp`).
`sendCode` in `src/index.ts` delivers it. Locally, `STEP_UP_LOG=1` in `.dev.vars` prints it to the
`wrangler dev` console. In production nothing sends it until you wire your mail or SMS sender
there: until then, asking for a code fails rather than print it to the Worker's logs.
//#if ai

### The model calls

The units call Omazy's models through the Core API. Give the Worker a token from your Omazy
workspace:

```sh
npx wrangler secret put OMAZY_TOKEN
```

For local runs, put it in `.dev.vars`. The tests never need it: they run on the testing kit's fake
Core API. `OMAZY_EVAL_LIVE=1 OMAZY_TOKEN=... npm test` runs the eval set against the live API.
//#endif
//#if oauth

## OAuth

`src/oauth.ts` wires the oauth kit, so clients like claude.ai can connect by signing in. It is
**off** (`OAUTH` is `"off"` in `wrangler.jsonc`) and should stay off until:

- you have read the [oauth kit page](https://docs.omazy.ai/build-on-omazy/kits/oauth/): its
  security fixes still need a final review before a product opens a door with it;
- `signInPage` in `src/oauth.ts` is your product's sign-in (the stub signs in a demo person
  under `wrangler dev` only), and `chooseSeat` and `checkSeat` read your members;
- `ISSUER` is your Worker's public URL.

Then set `OAUTH` to `"on"` and deploy. Personal keys keep working beside it.
//#endif

## Add a capability

1. Define it in `src/capabilities.ts` and add it to the registry: a name like `invoice_list`, a
   description that says what it does and what it is not for, a tier, and a preview for R2 and
   above.
2. Give it a permission and grant that in `src/access.ts`.
3. If it names a record, add the field to `NOTE_FIELDS` (or your own lookup in `tenantsOf`) and
   give the tenant isolation test its arguments.
4. `OMAZY_UPDATE_SNAPSHOTS=1 npm test`, review the snapshot change, commit.

The kits' pages say the rest: [capabilities](https://docs.omazy.ai/build-on-omazy/kits/capabilities/),
[guard](https://docs.omazy.ai/build-on-omazy/kits/guard/),
[mcp](https://docs.omazy.ai/build-on-omazy/kits/mcp/),
[testing](https://docs.omazy.ai/build-on-omazy/kits/testing/).

## The SDK version

`@omazyai/sdk` is pinned to the %%version%% release tarball, the version this project was made
with. The kits are experimental: read the
[release notes](https://docs.omazy.ai/build-on-omazy/release-notes/) before you move it.

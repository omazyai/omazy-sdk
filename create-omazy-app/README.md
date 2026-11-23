# create-omazy-app

Creates an AI product on the [Omazy SDK](https://docs.omazy.ai/build-on-omazy/) kits: a
Cloudflare Worker with capabilities, the guard and an MCP door, wired, tested and ready to deploy.

```sh
npm create omazy-app@latest my-product
bun create omazy-app my-product
pnpm create omazy-app my-product
```

In a terminal it asks for a name, the kits and your Cloudflare account. Or pass flags:

```sh
npm create omazy-app@latest my-product -- --preset full --account <id>
```

| Flag | What it does |
|---|---|
| `--preset minimal` | Capabilities, guard and mcp (the default) |
| `--preset full` | Every kit: ai, actor, flow, copilot with its page, and oauth (off until you turn it on) |
| `--kits ai,flow` | Pick kits on top of the base. actor, flow and copilot bring ai |
| `--account <id>` | Your Cloudflare account id, written into `wrangler.jsonc` |
| `--sdk <path or url>` | Install `@omazyai/sdk` from a local build or another tarball |
| `--yes` | Ask nothing |

The product pins `@omazyai/sdk` to the release tarball of the same version as this package.
Its README walks from `npm install` to a deployed MCP door. The guide is at
[docs.omazy.ai/build-on-omazy/create-omazy-app](https://docs.omazy.ai/build-on-omazy/create-omazy-app/).

## Developing it

```sh
bun test                                   # what it writes, with no network
OMAZY_E2E_SDK=<sdk .tgz> WORKERD_TOOLS=<folder with esbuild and miniflare> bun test
bun scripts/sync-migrations.ts             # after a kit adds a D1 migration
```

The second line installs each preset against the tarball, typechecks it, runs its tests, and
serves the minimal one under Miniflare. `release.sh` runs it on every release.

MIT. Author: Mosthofa Imran.

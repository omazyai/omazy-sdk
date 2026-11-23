// Personal keys: a bearer secret for one person's seat at the MCP door, for
// clients that cannot run OAuth (Claude Code, Cursor, a script). Only the
// key's SHA-256 is kept, in KV. A personal key lasts at most 90 days and
// reaches at most R2. Mint one with `npm run key`.

import { Keys, type KvLike } from '@omazyai/sdk/oauth/keys'
import config from './keys.json'
import { DOOR, type Door } from './types'

/** The key prefix names the product and the door, so a key for one door is refused at another. */
export const keyOptions = { personal: { prefix: (_door: Door) => config.prefix } }

export const keysFor = (kv: KvLike) => new Keys<Door>(kv, [DOOR], keyOptions)

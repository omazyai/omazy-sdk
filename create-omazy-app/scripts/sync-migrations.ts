// Writes the kits' SQL into templates/migrations from the SDK source beside
// this package, so a new product applies the same tables the kits create.
// The test in test/migrations.test.ts fails when they drift; run
// `bun scripts/sync-migrations.ts` after a kit adds a migration.

import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { kitMigrations } from './kit-migrations'

const dir = join(import.meta.dir, '..', 'templates', 'migrations')
for (const [file, sql] of Object.entries(kitMigrations())) writeFileSync(join(dir, file), sql)
console.log('wrote', Object.keys(kitMigrations()).join(', '))

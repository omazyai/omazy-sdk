// The SQL of each kit with D1 tables, from the SDK source of this release.

import { actorMigrationSql } from '../../typescript/src/actors/index'
import { aiMigrationSql } from '../../typescript/src/ai/index'
import { grantMigrationSql } from '../../typescript/src/copilot/index'
import { flowMigrationSql } from '../../typescript/src/flows/index'
import { guardMigrationSql } from '../../typescript/src/guard/index'

const head = (kit: string) => `-- The ${kit} kit's tables, from @omazyai/sdk. Additive and idempotent.\n\n`

export function kitMigrations(): Record<string, string> {
  return {
    'guard.sql': head('guard') + guardMigrationSql(),
    'ai.sql': head('ai') + aiMigrationSql(),
    'actors.sql': head('actors') + actorMigrationSql(),
    'flows.sql': head('flows') + flowMigrationSql(),
    'copilot.sql': `${head('copilot')}-- Standing grants.\n${grantMigrationSql()}`,
  }
}

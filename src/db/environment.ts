import { join } from 'node:path'
import { Context, Layer } from 'effect'

/**
 * Host facts `provision db` depends on. Locations keep the names used by the former `sandbox-db`
 * tool so existing global auth and lease records keep working:
 *
 * - global settings and the file-backed key: `${XDG_CONFIG_HOME:-~/.config}/pi/sandbox-db.{json,env}`
 * - lease records and locks: `${XDG_STATE_HOME:-~/.local/state}/pi/sandbox-db/{leases,locks}`
 */
export interface DbEnvironmentShape {
  readonly configDirectory: string
  readonly stateDirectory: string
  /** Process environment lookup for the explicit `NEON_AGENTS_SANDBOX_*` overrides. */
  readonly variable: (name: string) => string | undefined
  /** Whether the macOS keychain (`security`) may be used for the global key. */
  readonly keychain: boolean
}

export class DbEnvironment extends Context.Service<DbEnvironment, DbEnvironmentShape>()(
  'provision/db/DbEnvironment'
) {}

export const makeDbEnvironment = (
  env: Readonly<Record<string, string | undefined>>,
  platform: string
): DbEnvironmentShape => {
  const home = env.HOME ?? ''

  return {
    configDirectory: join(env.XDG_CONFIG_HOME ?? join(home, '.config'), 'pi'),
    stateDirectory: join(env.XDG_STATE_HOME ?? join(home, '.local', 'state'), 'pi', 'sandbox-db'),
    variable: name => env[name],
    keychain: platform === 'darwin'
  }
}

export const DbEnvironmentLive = Layer.sync(DbEnvironment, () =>
  makeDbEnvironment(process.env, process.platform)
)

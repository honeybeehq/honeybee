// Select only a reviewed profile in the exact source checkout.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseDistributionProfile, productionProfile, distributionIdentity } from '../src/release/distribution-profile.ts'
export function selectedDistribution(root, env = process.env) {
  const id = env.RELEASE_DISTRIBUTION || 'production'
  if (id === 'production') return productionProfile
  if (!/^[a-z][a-z0-9-]{0,47}$/.test(id)) throw new Error('Invalid distribution selector')
  const profile = parseDistributionProfile(JSON.parse(readFileSync(join(root, '.release/distributions', `${id}.json`), 'utf8')))
  if (profile.id !== id || distributionIdentity(profile) !== env.RELEASE_DISTRIBUTION_SHA256) throw new Error('Distribution fingerprint mismatch')
  return profile
}

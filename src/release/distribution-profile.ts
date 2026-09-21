// Trusted build/producer input. Never construct this from downloaded metadata.
import { createHash, createPublicKey } from 'node:crypto'
export type DistributionProfile = { readonly schemaVersion: 1; readonly id: string; readonly repository: string; readonly verificationKeys: Readonly<Record<string, string>> };
export const productionRepository = 'honeybeehq/apiary-releases'
export const productionProfile: DistributionProfile = Object.freeze({ schemaVersion: 1, id: 'production', repository: productionRepository, verificationKeys: Object.freeze({}) })
export function parseDistributionProfile(value: any): DistributionProfile {
  if (!value || Object.keys(value).sort().join(',') !== 'id,repository,schemaVersion,verificationKeys' || value.schemaVersion !== 1
    || typeof value.id !== 'string' || !/^[a-z][a-z0-9-]{0,47}$/.test(value.id)
    || typeof value.repository !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value.repository)
    || (value.id === 'production') !== (value.repository.toLowerCase() === productionRepository)
    || !value.verificationKeys || typeof value.verificationKeys !== 'object' || Array.isArray(value.verificationKeys)) throw new Error('Invalid distribution profile')
  const verificationKeys: Record<string, string> = Object.create(null)
  for (const id of Object.keys(value.verificationKeys).sort()) {
    const pem = value.verificationKeys[id]
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id) || typeof pem !== 'string') throw new Error('Invalid distribution key')
    const key = createPublicKey(pem)
    if (key.asymmetricKeyType !== 'ed25519') throw new Error('Ed25519 distribution key required')
    verificationKeys[id] = key.export({ format: 'pem', type: 'spki' }).toString()
  }
  if (value.id !== 'production' && !Object.keys(verificationKeys).length) throw new Error('Staging distribution requires out-of-band verification keys')
  return Object.freeze({ schemaVersion: 1, id: value.id, repository: value.repository.toLowerCase(), verificationKeys: Object.freeze(verificationKeys) })
}
export function distributionIdentity(input: DistributionProfile) {
  return createHash('sha256').update(JSON.stringify(parseDistributionProfile(input))).digest('hex')
}
export function distributionPrefix(input: DistributionProfile) {
  const p = parseDistributionProfile(input)
  return p.id === 'production' ? '' : `distribution-${distributionIdentity(p)}-`
}
export function distributionBootstrap(input: DistributionProfile) {
  return `https://github.com/${parseDistributionProfile(input).repository}/releases/latest/download/release-bootstrap.json`
}

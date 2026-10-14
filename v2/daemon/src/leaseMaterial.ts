import { recipeFor, parseClaudeCredentials, parseMuseCredentials, type AccountRow } from "../../core/src/index.ts";
import { CODEX_CREDENTIAL_CODEC } from "./codexCredentialAuthority.ts";
import { grokAccessOnly, grokCredentialEntry } from "./grokCredentialAuthority.ts";
import type { KeychainState, KeychainStateReader, KeychainRemover } from "./keychain.ts";

export interface LeaseKeychainCodec {
  assertHome: (homePath: string) => void;
  read: KeychainStateReader;
  publish: (account: AccountRow, raw: string, state: KeychainState) => Promise<boolean>;
  remove: KeychainRemover;
  matchesMaterial: (stored: string, installed: string) => boolean;
  withLock: <T>(homePath: string, run: () => Promise<T>) => Promise<T>;
}

export interface LeaseMaterialCodec {
  provesAccessOnly?: (document: Record<string, unknown>) => boolean;
  primaryFile: string;
  files: readonly string[];
  mirrors: Readonly<Record<string, string>>;
  keychain?: LeaseKeychainCodec;
  accessOnly?: (document: Record<string, unknown>) => Record<string, unknown>;
}

export function createLeaseMaterialCodecs(claude: LeaseKeychainCodec): ReadonlyMap<string, LeaseMaterialCodec> {
  const accessOnly = new Map([["grok", grokAccessOnly]]);
  const nonempty = (value: unknown) => typeof value === "string" && value.length > 0;
  const proofs = new Map<string, (document: Record<string, unknown>) => boolean>([
    ["claude", document => parseClaudeCredentials(JSON.stringify(document)) !== null],
    ["codex", document => CODEX_CREDENTIAL_CODEC.parse(JSON.stringify(document)) !== null],
    ["grok", document => grokCredentialEntry(document) !== null || Object.values(document).length > 0 && Object.values(document).every(value => value !== null && typeof value === "object" && !Array.isArray(value) && (value as Record<string, unknown>).auth_mode === "api_key" && nonempty((value as Record<string, unknown>).key))],
    ["kimi", document => nonempty(document.api_key)],
    ["opencode", document => Object.values(document).length > 0 && Object.values(document).every(value => value !== null && typeof value === "object" && !Array.isArray(value) && ((value as Record<string, unknown>).type === "oauth" && nonempty((value as Record<string, unknown>).access) || (value as Record<string, unknown>).type === "api" && nonempty((value as Record<string, unknown>).key)))],
    ["muse", document => { const credential = parseMuseCredentials(JSON.stringify(document)); return credential !== null && credential.mechanism !== "keychain"; }],
  ]);
  return new Map([...proofs.keys()].map(harness => {
    const recipe = recipeFor(harness)!;
    return [harness, {
      provesAccessOnly: proofs.get(harness),
      primaryFile: recipe.credentialFiles[0]!,
      files: recipe.credentialFiles,
      mirrors: recipe.activationMirrors ?? {},
      accessOnly: accessOnly.get(harness),
      ...(harness === "claude" ? { keychain: claude } : {}),
    }];
  }));
}

export function hasRefreshGrant(value: unknown): boolean {
  if (value === null || typeof value !== "object") return false;
  return Object.entries(value).some(([key, child]) => ["refreshToken", "refresh_token", "refresh"].includes(key) && child !== "" && child !== null || hasRefreshGrant(child));
}

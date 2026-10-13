import { recipeFor, type AccountRow } from "../../core/src/index.ts";
import { grokAccessOnly } from "./grokCredentialAuthority.ts";
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
  primaryFile: string;
  files: readonly string[];
  mirrors: Readonly<Record<string, string>>;
  keychain?: LeaseKeychainCodec;
  accessOnly?: (document: Record<string, unknown>) => Record<string, unknown>;
}

export function createLeaseMaterialCodecs(claude: LeaseKeychainCodec): ReadonlyMap<string, LeaseMaterialCodec> {
  const accessOnly = new Map([["grok", grokAccessOnly]]);
  return new Map(["claude", "codex", "grok", "opencode"].map(harness => {
    const recipe = recipeFor(harness)!;
    return [harness, {
      primaryFile: recipe.credentialFiles[0]!,
      files: recipe.credentialFiles,
      mirrors: recipe.activationMirrors ?? {},
      accessOnly: accessOnly.get(harness),
      ...(harness === "claude" ? { keychain: claude } : {}),
    }];
  }));
}

import { recipeFor, type AccountRow } from "../../core/src/index.ts";
import type { KeychainState, KeychainStateReader, KeychainRemover } from "./keychain.ts";

export interface LeaseKeychainCodec {
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
}

export function createLeaseMaterialCodecs(claude: LeaseKeychainCodec): ReadonlyMap<string, LeaseMaterialCodec> {
  return new Map(["claude", "codex", "grok", "opencode"].map(harness => {
    const recipe = recipeFor(harness)!;
    return [harness, {
      primaryFile: recipe.credentialFiles[0]!,
      files: recipe.credentialFiles,
      mirrors: recipe.activationMirrors ?? {},
      ...(harness === "claude" ? { keychain: claude } : {}),
    }];
  }));
}

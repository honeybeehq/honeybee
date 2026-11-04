import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import { ownerCheckoutName, normalizeGitOrigin, verifiedUpstreamUrl, formatCheckoutName } from "../src/upstreamUrl.ts";
import { UpstreamFetchMonitor, upstreamFetchLine } from "../src/upstreamStatus.ts";
import { UpstreamFetchError } from "../src/upstreamFetch.ts";

test("upstream URL consistency follows the shared canonical origin and checkout-name format", () => {
  const canonical = "github.com/honeybeehq/honeybee";
  const name = "github-com-honeybeehq-honeybee-a9015b303498";
  assert.equal(ownerCheckoutName(canonical), name);
  for (const url of ["https://github.com/HoneybeeHQ/Honeybee.git", "git@github.com:HoneybeeHQ/Honeybee.git", "ssh://git@github.com/honeybeehq/honeybee"]) {
    assert.equal(normalizeGitOrigin(url), canonical);
    assert.equal(verifiedUpstreamUrl(join("/fixture", name), [url]), url);
  }
  const explicitPort = "ssh://git@github.com:22/honeybeehq/honeybee";
  const portCanonical = "github.com/22/honeybeehq/honeybee";
  assert.equal(normalizeGitOrigin(explicitPort), portCanonical);
  assert.equal(verifiedUpstreamUrl(join("/fixture", ownerCheckoutName(portCanonical)), [explicitPort]), explicitPort);
  assert.ok(ownerCheckoutName(`example.com/${"long-name-".repeat(20)}/repo`).length <= 80);
  assert.equal(formatCheckoutName(canonical, "invalid"), undefined);
});

test("upstream URL consistency refuses unknown placements, ambiguous values and unsafe syntax", () => {
  const root = join("/fixture", ownerCheckoutName("github.com/org/repo"));
  for (const candidates of [[], ["https://github.com/org/repo", "git@github.com:org/repo"], ["https://github.com/other/repo"], ["https://user:secret@github.com/org/repo"], ["ssh://other@github.com/org/repo"], ["ssh://git:secret@github.com/org/repo"], ["ssh://git@github.com:7999/org/repo"], ["https://github.com:8443/org/repo"], ["https://github.com/org/repo?x=1"], ["https://github.com/org/repo#fragment"], ["https://github.com/org/../repo"], ["https://github.com/org/%72epo"], ["file:///fixture/repo"], ["/fixture/repo"], ["git://github.com/org/repo"]]) {
    assert.throws(() => verifiedUpstreamUrl(root, candidates), (error: unknown) => error instanceof UpstreamFetchError && error.code === "provenance_refused", JSON.stringify(candidates));
  }
  assert.throws(() => verifiedUpstreamUrl("/fixture/operator-named", ["https://github.com/org/repo"]), /custom placements/u);
  assert.equal(verifiedUpstreamUrl("/fixture/local", ["/fixture/remote"], true), "/fixture/remote");
});

test("upstream holds remain visible until a background success and restart starts unchecked", () => {
  const monitor = new UpstreamFetchMonitor();
  assert.match(upstreamFetchLine(monitor.snapshot(true)), /awaiting background check/u);
  monitor.observe("/fixture/repo", { status: "failed", code: "invalid_objects", error: "objects refused", parked: true });
  const status = monitor.snapshot(true);
  assert.equal(status.failures[0]!.parked, true);
  assert.match(upstreamFetchLine(status), /invalid_objects.*parked/u);
  status.failures.length = 0;
  assert.equal(monitor.snapshot(true).failures.length, 1);
  monitor.observe("/fixture/repo", { status: "fresh" });
  assert.equal(monitor.snapshot(true).failures.length, 0);
  assert.equal(new UpstreamFetchMonitor().snapshot(true).checked, false);
});

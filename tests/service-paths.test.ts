import assert from "node:assert/strict";
import { test } from "node:test";
import { serviceDirectory } from "../src/servicePaths.js";

test("service paths depend only on explicit HOME/XDG configuration and overrides", () => {
  assert.equal(serviceDirectory("linux", { HOME: "/scratch/home" }), "/scratch/home/.config/systemd/user");
  assert.equal(serviceDirectory("linux", { HOME: "/scratch/home", XDG_CONFIG_HOME: "/scratch/config" }), "/scratch/config/systemd/user");
  assert.equal(serviceDirectory("darwin", { HOME: "/scratch/home" }), "/scratch/home/Library/LaunchAgents");
  assert.equal(serviceDirectory("darwin", { HIVE_V2_SERVICE_DIR: "/scratch/agents" }), "/scratch/agents");
  assert.throws(() => serviceDirectory("linux", {}), /HOME required/);
  assert.throws(() => serviceDirectory("darwin", { HOME: "relative" }), /HOME required/);
});

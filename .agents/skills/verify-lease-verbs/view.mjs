export const title = "One shared account on one satellite: lease window, epoch, release and the bulk key";
const lease = v => v.epoch === 0 ? "No lease on the satellite" : `${v.revoked ? "Released" : "Lease held"} (epoch ${v.epoch}, window ${v.window})`;
const key = v => v.keyState === "none" ? "Bulk key unused" : v.replayWindow === 0 ? "Bulk key recorded" : "Bulk key replayed";
export const state = v => ({ Lease: lease(v), BulkKey: key(v) });
export const group = v => v.epoch === 0 ? "empty" : v.revoked ? "released" : "held";
export const colors = { empty: "tan", held: "teal", released: "orange" };
export const step = (action, from, to) => {
  if (action.startsWith("Grant")) return from.payloads.length === to.payloads.length ? null : "the owner mints a lease payload";
  if (action === "TakeOver") return "another computer takes over the login";
  if (action.startsWith("Install")) return from.epoch === to.epoch && from.window === to.window && from.revoked === to.revoked ? null : to.epoch > from.epoch && from.epoch > 0 ? "a lease from the new authority installs" : from.revoked ? "a fresh lease installs again" : "a lease installs";
  if (action === "Release") return "the lease is released";
  if (action.startsWith("BatchFirst")) return "the bulk call runs under its key";
  if (action.startsWith("BatchReplay")) return "the same key is sent again";
  return action;
};

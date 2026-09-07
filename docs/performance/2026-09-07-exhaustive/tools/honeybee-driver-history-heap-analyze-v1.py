"""Offline structural analysis of HsrDriver.consumed in V8 heap snapshots.

Finds HsrDriver instances, follows the `consumed` property edge to its Map
and the Map's internal `table`, and reports SHALLOW self bytes plus the
retaining structure (bounded incoming-edge listing per node of interest).
Numeric keys/values are smis stored inline in the backing store: they emit
NO edges, so edge counts are reported by type as evidence that edges must
never be counted as entries; the entry count authority is the probe's
externally proven receipt. Existence-only comparison across snapshots; no
dominator or retained-byte attribution, no whole-process claims.
"""
import argparse, hashlib, json
from pathlib import Path

p = argparse.ArgumentParser()
p.add_argument("snapshot")
p.add_argument("--out", required=True)
a = p.parse_args()
source = Path(a.snapshot)
data = source.read_bytes()
h = json.loads(data)
meta = h["snapshot"]["meta"]
nf = meta["node_fields"]
ef = meta["edge_fields"]
nw = len(nf)
ew = len(ef)
nodes = h["nodes"]
edges = h["edges"]
strings = h["strings"]
nt = meta["node_types"][nf.index("type")]
et = meta["edge_types"][ef.index("type")]
assert len(nodes) % nw == 0 and len(edges) % ew == 0

starts = {}
offset = 0
for i in range(0, len(nodes), nw):
    starts[i] = offset
    offset += nodes[i + nf.index("edge_count")] * ew
assert offset == len(edges)

def node(i):
    assert i % nw == 0 and 0 <= i < len(nodes)
    return {
        "id": nodes[i + nf.index("id")],
        "type": nt[nodes[i + nf.index("type")]],
        "name": strings[nodes[i + nf.index("name")]],
        "shallowBytes": nodes[i + nf.index("self_size")],
        "edgeCount": nodes[i + nf.index("edge_count")],
    }

def outgoing(i):
    end = starts[i] + nodes[i + nf.index("edge_count")] * ew
    for e in range(starts[i], end, ew):
        typ = et[edges[e + ef.index("type")]]
        key = edges[e + ef.index("name_or_index")]
        yield typ, key if typ in ["element", "hidden"] else strings[key], edges[e + ef.index("to_node")]

# Reverse index only for targets we care about (built lazily in one pass).
def retainers_of(targets, cap=12):
    result = {t: [] for t in targets}
    for i in starts:
        for typ, name, to in outgoing(i):
            if to in result and len(result[to]) < cap:
                src = node(i)
                result[to].append({
                    "fromType": src["type"], "fromName": src["name"], "fromId": src["id"],
                    "edgeType": typ, "edgeName": name if isinstance(name, str) else f"[{name}]",
                })
    return result

drivers = [i for i in starts if node(i)["type"] == "object" and node(i)["name"] == "HsrDriver"]
found = []
interesting = []
for d in drivers:
    props = {name: to for typ, name, to in outgoing(d) if typ == "property"}
    item = {"driver": node(d), "hasConsumedProperty": "consumed" in props}
    if "consumed" in props:
        m = props["consumed"]
        item["consumedMap"] = node(m)
        tables = [to for t, n, to in outgoing(m) if t == "internal" and n == "table"]
        if len(tables) == 1:
            t = tables[0]
            tn = node(t)
            edge_types = {}
            for typ, _n, _to in outgoing(t):
                edge_types[typ] = edge_types.get(typ, 0) + 1
            item["table"] = tn
            item["tableOutgoingEdgeCountsByType"] = edge_types
            item["smiNote"] = (
                "numeric keys/values are smis stored inline: outgoing edges on the "
                "table do NOT enumerate entries and must never be counted as such"
            )
            interesting.extend([d, m, t])
        else:
            item["table"] = None
            item["tableEdgeAnomaly"] = len(tables)
            interesting.extend([d, m])
    else:
        interesting.append(d)
    found.append(item)

retainers = retainers_of(set(interesting)) if interesting else {}
for item in found:
    item["driverRetainers"] = retainers.get(next(i for i in drivers if node(i)["id"] == item["driver"]["id"]), [])
    # attach map/table retainers by id lookup
for item in found:
    for key, label in (("consumedMap", "consumedMapRetainers"), ("table", "tableRetainers")):
        if item.get(key):
            wanted = item[key]["id"]
            for i, rs in retainers.items():
                if node(i)["id"] == wanted:
                    item[label] = rs
                    break

result = {
    "snapshotPath": str(source.resolve()),
    "snapshotSha256": hashlib.sha256(data).hexdigest(),
    "toolSha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
    "scope": __doc__,
    "hsrDriverInstances": len(drivers),
    "findings": found,
    "totalNodes": len(nodes) // nw,
}
out = Path(a.out)
assert not out.exists()
out.write_text(json.dumps(result, indent=2) + "\n")
print(json.dumps({
    "snapshot": source.name,
    "hsrDriverInstances": len(drivers),
    "consumedMaps": sum(1 for f in found if f.get("consumedMap")),
    "tableShallowBytes": [f["table"]["shallowBytes"] for f in found if f.get("table")],
    "mapShallowBytes": [f["consumedMap"]["shallowBytes"] for f in found if f.get("consumedMap")],
    "tableEdgeTypes": [f.get("tableOutgoingEdgeCountsByType") for f in found if f.get("table")],
}))

"""Offline structural analysis of HsrDriver.consumed in V8 heap snapshots (v2).

Finds HsrDriver instances and CLASSIFIES the `consumed` property target as
map / not_map / missing using the actual node type ("object") and name
("Map") BEFORE calling anything a consumedMap or traversing a table. Only a
classified map is traversed. Reports SHALLOW self bytes and bounded
retaining structure. Structural anomalies are recorded as JSON evidence and
the report is WRITTEN BEFORE a nonzero exit.

Smi scope, fixture-qualified: for small numeric ids/generations within smi
range (like the 1..100000/gen-1 baseline fixture) keys and values are
stored inline and emit NO edges, so edge counts must never be read as entry
counts there; larger numerics would be heap numbers with real edges and a
different byte shape. Entry-count authority stays external (probe receipt).
No dominator or retained-byte attribution; no whole-process claims.
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
anomalies = []
interesting = []
for d in drivers:
    props = {name: to for typ, name, to in outgoing(d) if typ == "property"}
    item = {"driver": node(d)}
    if "consumed" not in props:
        item["classification"] = "missing"
        item["consumedTarget"] = None
        interesting.append(d)
        found.append(item)
        continue
    target = props["consumed"]
    tn = node(target)
    item["consumedTarget"] = tn
    if tn["type"] == "object" and tn["name"] == "Map":
        item["classification"] = "map"
        tables = [to for t, n, to in outgoing(target) if t == "internal" and n == "table"]
        if len(tables) != 1:
            anomalies.append({
                "code": "table_edge_count",
                "driverId": node(d)["id"],
                "mapId": tn["id"],
                "observedTableEdges": len(tables),
            })
            item["table"] = None
        else:
            t = tables[0]
            edge_types = {}
            for typ, _n, _to in outgoing(t):
                edge_types[typ] = edge_types.get(typ, 0) + 1
            item["table"] = node(t)
            item["tableOutgoingEdgeCountsByType"] = edge_types
            item["smiNote"] = (
                "fixture-qualified: small in-smi-range numeric keys/values are stored "
                "inline and emit no edges, so these edge counts never enumerate entries; "
                "larger numerics would be heap numbers with real edges"
            )
            interesting.append(t)
        interesting.extend([d, target])
    else:
        # Honest label with the observed node; no traversal of a non-Map.
        item["classification"] = "not_map"
        interesting.extend([d, target])
    found.append(item)

retainers = retainers_of(set(interesting)) if interesting else {}
by_id = {node(i)["id"]: rs for i, rs in retainers.items()}
for item in found:
    item["driverRetainers"] = by_id.get(item["driver"]["id"], [])
    if item.get("consumedTarget"):
        item["consumedTargetRetainers"] = by_id.get(item["consumedTarget"]["id"], [])
    if item.get("table"):
        item["tableRetainers"] = by_id.get(item["table"]["id"], [])

summary_classes = {}
for item in found:
    summary_classes[item["classification"]] = summary_classes.get(item["classification"], 0) + 1

result = {
    "snapshotPath": str(source.resolve()),
    "snapshotSha256": hashlib.sha256(data).hexdigest(),
    "toolSha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
    "scope": __doc__,
    "hsrDriverInstances": len(drivers),
    "classificationCounts": summary_classes,
    "findings": found,
    "anomalies": anomalies,
    "completed": True,
    "totalNodes": len(nodes) // nw,
}
out = Path(a.out)
assert not out.exists()
out.write_text(json.dumps(result, indent=2) + "\n")
print(json.dumps({
    "snapshot": source.name,
    "hsrDriverInstances": len(drivers),
    "classificationCounts": summary_classes,
    "tableShallowBytes": [f["table"]["shallowBytes"] for f in found if f.get("table")],
    "anomalies": len(anomalies),
}))
raise SystemExit(1 if anomalies else 0)

"""Offline structural inspection of the candidate's closure-local title cache.

Consumes V8's own metadata fields from a JSON heap snapshot. Follows the
context slot named quietBaselines to a Map, then that Map's table to entry
objects with membership/signature properties. Counts observed objects only.
This is neither a dominator calculation nor retained-byte attribution.
Source review must verify the slot name belongs to the intended dispatcher.
"""
import argparse,gzip,hashlib,json
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('snapshot');p.add_argument('--out',required=True);a=p.parse_args()
source=Path(a.snapshot);raw=source.read_bytes();data=gzip.decompress(raw) if source.suffix=='.gz' else raw
h=json.loads(data);meta=h['snapshot']['meta'];nf=meta['node_fields'];ef=meta['edge_fields'];nw=len(nf);ew=len(ef)
nodes=h['nodes'];edges=h['edges'];strings=h['strings'];nt=meta['node_types'][nf.index('type')];et=meta['edge_types'][ef.index('type')]
assert len(nodes)%nw==0 and len(edges)%ew==0
starts={};offset=0
for i in range(0,len(nodes),nw):
 starts[i]=offset;offset+=nodes[i+nf.index('edge_count')]*ew
assert offset==len(edges)
def node(i):
 assert i%nw==0 and 0<=i<len(nodes)
 return {'id':nodes[i+nf.index('id')],'type':nt[nodes[i+nf.index('type')]],'name':strings[nodes[i+nf.index('name')]],'shallowBytes':nodes[i+nf.index('self_size')]}
def outgoing(i):
 end=starts[i]+nodes[i+nf.index('edge_count')]*ew
 for e in range(starts[i],end,ew):
  typ=et[edges[e+ef.index('type')]];key=edges[e+ef.index('name_or_index')]
  yield typ, key if typ in ['element','hidden'] else strings[key], edges[e+ef.index('to_node')]
def properties(i):return {name:to for typ,name,to in outgoing(i) if typ=='property'}
found=[]
for i in starts:
 for typ,name,target in outgoing(i):
  if typ!='context' or name!='quietBaselines':continue
  item={'context':node(i),'slot':name,'target':node(target),'entries':[]}
  if item['target']['type']=='object' and item['target']['name']=='Map':
   tables=[to for t,n,to in outgoing(target) if t=='internal' and n=='table'];assert len(tables)==1
   item['table']=node(tables[0]);seen=set()
   for t,n,value in outgoing(tables[0]):
    if t=='weak' or value in seen:continue
    seen.add(value);pr=properties(value)
    if 'membership' not in pr or 'signature' not in pr:continue
    membership=pr['membership'];mp=properties(membership)
    assert 'kind' in mp and node(mp['kind'])['name']=='committed'
    sig=node(pr['signature']);assert sig['type'] in ['string','concatenated string','sliced string']
    item['entries'].append({'entry':node(value),'membership':node(membership),'signature':sig})
   item['observedEntryObjects']=len(item['entries'])
  found.append(item)
result={'snapshotPath':str(source.resolve()),'snapshotSha256':hashlib.sha256(data).hexdigest(),'toolSha256':hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),'scope':__doc__,'cacheSlots':found,'coreStoreObjects':sum(node(i)['type']=='object' and node(i)['name']=='CoreStore' for i in starts)}
out=Path(a.out);assert not out.exists();out.write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps({'cacheSlots':len(found),'mapEntryCounts':[x.get('observedEntryObjects') for x in found],'coreStoreObjects':result['coreStoreObjects']}))

from pathlib import Path
import csv,json,re,collections,hashlib,subprocess
root=Path.cwd();out=Path('/tmp/honeybee-perf-inventory-2026-09-07')
raw=[l.split('|') for l in (out/'inventory-source.txt').read_text().splitlines()];header=raw[0];rows=raw[1:]
order=['C','D','R','L','H','A','T','E','S','P','X','Z']
rows.sort(key=lambda r:(order.index(re.match('[A-Z]+',r[0]).group()),int(re.search(r'\d+',r[0]).group())))
assert all(len(r)==10 for r in rows)
assert len(rows)==len({r[0] for r in rows})==153
anchors=[];errors=[]
for row in rows:
 for loc in row[1].split('; '):
  path,sep,syms=loc.partition(':');p=root/path
  if not p.exists() or not sep:errors.append((row[0],loc,'path/symbol absent'));continue
  text=p.read_text();lines=text.splitlines()
  for sym in syms.split(', '):
   token=sym.rsplit('.',1)[-1]
   if token=='top-level':line=1
   else:
    candidates=[i for i,l in enumerate(lines,1) if re.search(r'\b'+re.escape(token)+r'\b',l)]
    if not candidates:errors.append((row[0],loc,sym));continue
    definitions=[i for i in candidates if re.search(r'(?:function|class|const)\s+'+re.escape(token)+r'\b',lines[i-1]) or re.search(r'^\s*(?:(?:private|public|static|async|readonly|export)\s+)*'+re.escape(token)+r'\s*[(:=]',lines[i-1])]
    line=definitions[0] if definitions else candidates[0]
   anchors.append([row[0],path,sym,line,hashlib.sha256(p.read_bytes()).hexdigest()])
assert not errors,errors
for name,data in [('inventory.tsv',[header]+rows),('anchors.tsv',[['id','path','symbol','line','file_sha256']]+anchors)]:
 with (out/name).open('w') as f:csv.writer(f,delimiter='\t',lineterminator='\n').writerows(data)
files=(out/'tracked-files.txt').read_text().splitlines();dirs=collections.Counter(str(Path(p).parent) for p in files)
source_map={'accounts':'X23,X33','buz':'X15','cli':'L01,L10,X07','comb':'X20','commands':'L10,P02,X01-X35','completion':'L10','daemon':'X04-X06,X16,X33,X35','execution':'X17-X19','flight':'X22','flow':'X21','hsr':'X07-X13','limits':'X23','loop':'X21','recovery':'X16','requests':'X29','search':'X25','spend':'X26','substrates':'X10-X14','tasks':'X15,X21','transcripts':'X24','view':'X01'}
v2map={'core':'C01-C29','daemon':'D01-D10,R01-R07,S01-S17,P04-P06,Z01-Z02','cli':'L01-L11','adapters':'A01-A05','driver-hsr':'H01-H10','driver-cell':'E01-E12','driver-tmux':'T01-T07,A06','harness':'P01,Z02'}
coverage=[]
for d,n in sorted(dirs.items()):
 if d=='src':level='All source indexed; selected bodies/call paths inspected';ids='L01,P01-P05,S09,X01-X35'
 elif d.startswith('src/'):
  level='All source indexed; selected bodies/call paths inspected';ids=source_map[d.split('/')[1]]
 elif d.startswith('v2/'):
  ids=v2map[d.split('/')[1]]
  if '/src' in d:level='All source indexed; operational bodies inspected selectively'
  elif '/tests' in d or '/test-agent' in d:level='Paths and verification role inventoried; no execution or exhaustive body review'
  else:level='Package/tsconfig/smoke role inventoried; no builds or smokes'
 elif d.startswith('scripts'):
  ids='P01-P07,I1-I9';level='All scripts indexed; selected ruler/build bodies and guides inspected'
 elif d.startswith('contracts'):
  ids='X17,X20,P01';level='Shipped corpus paths inventoried; loader/export inspected, corpus not exhaustively read'
 elif d.startswith('tests'):
  ids='Verification targets in inventory';level='Paths inventoried; no test execution or exhaustive body review'
 elif d.startswith('docs/performance'):
  ids='B0-B3';level='Required September reports/guides read; raw artifacts enumerated, not recaptured/recomputed'
 elif d.startswith('docs'):
  ids='Context only';level='Paths inventoried; contents not comprehensively inspected'
 elif d.startswith('.agents'):
  ids='K1-K8';level='Mandatory SKILL read completely; companion metadata inventoried'
 elif d.startswith('.claude'):
  ids='Excluded instruction source';level='Inventory only; CLAUDE ignored per user instruction'
 else:
  ids='P01,L01,X17';level='AGENTS/package/export/build metadata inspected; lockfile and scratch not exhaustively read'
 coverage.append([d,n,level,ids])
assert len(coverage)==113
with (out/'coverage.tsv').open('w') as f:csv.writer(f,delimiter='\t',lineterminator='\n').writerows([['directory','direct_tracked_files','inspection','inventory_ids']]+coverage)
context=(out/'report-context.md').read_text()
sections={'C':'Core and SQLite','D':'Daemon lifecycle and scheduling','R':'RPC, snapshots and subscriptions','L':'CLI and completion','H':'HSR host, observation and recovery','A':'Adapters and transcript projection','T':'tmux driver','E':'Cells, Git and filesystem','S':'Accounts, auth, config and naming','P':'Build, deployment, retention and profiling','X':'Conditionally shipped legacy operations','Z':'Cross-operation lifetime and saturation'}
md=[context,'\n## Full stable-ID inventory\n']
for group in order:
 md+=['\n### '+sections[group]+'\n','| '+' | '.join(header)+' |','| '+ ' | '.join(['---']*len(header))+' |']
 for r in rows:
  if re.match('[A-Z]+',r[0]).group()!=group:continue
  rr=r.copy();rr[1]='<br>'.join('`'+l+'`' for l in r[1].split('; '))
  md.append('| '+' | '.join(rr)+' |')
(out/'report.md').write_text('\n'.join(md)+'\n')
manifest={'baseline':subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip(),'inventory_rows':len(rows),'source_anchor_rows':len(anchors),'directory_rows':len(coverage),'tracked_files':len(files),'validation':'All row IDs unique; all ten fields present; every location file exists and each named symbol token occurs in that source; anchors are lexical, not compiler resolution. No tests/builds/captures run.','artifacts':{p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in out.iterdir() if p.is_file() and p.name!='manifest.json'}}
(out/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
print(json.dumps({k:v for k,v in manifest.items() if k!='artifacts'},indent=2))
print('Repository status:',subprocess.check_output(['git','status','--short'],text=True).strip() or 'clean')

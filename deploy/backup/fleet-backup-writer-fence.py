#!/usr/bin/python3
"""Root-only fixed-argv lifecycle helper. Never install or invoke it against real units in a drill."""
import fcntl, http.client, json, os, re, signal, socket, subprocess, sys, time
from pathlib import Path
FORMAT = 'honeybee.writer-fence.v1'
class FenceError(Exception): pass

def proc(pid):
    try:
        value = Path('/proc/%d/stat' % pid).read_text().rsplit(')', 1)[1].split()
        uid=int(next(line for line in Path('/proc/%d/status'%pid).read_text().splitlines() if line.startswith('Uid:')).split()[2]);return {'pid':pid,'birth':'linux:'+value[19], 'bootId':Path('/proc/sys/kernel/random/boot_id').read_text().strip()}, int(value[2]), uid
    except FileNotFoundError: return None

def absent(identity):
    boot = Path('/proc/sys/kernel/random/boot_id').read_text().strip()
    if boot != identity['bootId']: return True
    # The maintenance guard is a process-group leader. Check its entire group, even if
    # a SIGKILL removed that leader before its rest-server child could be reaped.
    for item in Path('/proc').iterdir():
        if item.name.isdecimal():
            value = proc(int(item.name))
            if value and value[1] == identity['pid']: return False
    last=proc(identity['pid']);return last is None or last[0]!=identity

def reap_orphans(identity, uid):
    if Path('/proc/sys/kernel/random/boot_id').read_text().strip()!=identity['bootId']: return True
    if proc(identity['pid']) is not None: return False
    for sig in [signal.SIGTERM,signal.SIGKILL]:
        if proc(identity['pid']) is not None: return False
        members=[]
        for item in Path('/proc').iterdir():
            if item.name.isdecimal():
                value=proc(int(item.name))
                if value and value[1]==identity['pid']:
                    if value[2]!=uid: return False
                    members.append(value)
        for member in members:
            fd=None
            try:
                fd=os.pidfd_open(member[0]['pid'],0)
                fresh=proc(member[0]['pid'])
                if fresh and fresh[0]==member[0] and fresh[1]==identity['pid'] and fresh[2]==uid:
                    if proc(identity['pid']) is not None: return False
                    signal.pidfd_send_signal(fd,sig)
            except ProcessLookupError: pass
            finally:
                if fd is not None: os.close(fd)
        deadline=time.monotonic()+2
        while time.monotonic()<deadline:
            if absent(identity): return True
            time.sleep(.02)
    return absent(identity)

def writer_ready(port, machine):
    deadline=time.monotonic()+10
    while time.monotonic()<deadline:
        connection=http.client.HTTPConnection('127.0.0.1',port,timeout=.5)
        try:
            connection.request('GET','/'+machine+'/config');response=connection.getresponse();response.read(1024)
            if response.status==401: return True
        except (OSError,http.client.HTTPException): pass
        finally: connection.close()
        time.sleep(.05)
    return False

def systemd(action, unit):
    if action in ('stop','start'):
        subprocess.run(['/usr/bin/systemctl', action, unit], check=True, timeout=10, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    result = subprocess.run(['/usr/bin/systemctl','show',unit,'--property=ActiveState,SubState,MainPID,ControlPID,ControlGroup'],check=True,timeout=10,capture_output=True,text=True)
    state = dict(line.split('=',1) for line in result.stdout.splitlines() if '=' in line)
    if state.get('ActiveState') == 'inactive' and state.get('SubState') == 'dead':
        if state.get('MainPID') != '0' or state.get('ControlPID') != '0': raise FenceError()
        group = state.get('ControlGroup','')
        if group:
            if not group.startswith('/') or '..' in group.split('/'): raise FenceError()
            directory = Path('/sys/fs/cgroup'+group)
            for file in directory.rglob('cgroup.procs'):
                if file.read_text().strip(): raise FenceError()
    return state

class WriterFence:
    # Paths/adapters are injectable only by imported disposable tests, never CLI/env input.
    def __init__(self, root=Path('/var/lib/fleet-backup/writer-fences'), allocations=Path('/etc/fleet-backup/allocations.tsv'), repos=Path('/p4/main/depots/fleet-backup/repos'), manager=systemd, gone=absent, inspect=proc, owner_uid=None, ready=writer_ready):
        self.ready=ready
        self.owner_uid=os.getuid() if owner_uid is None else owner_uid
        if self.owner_uid<=0: raise FenceError()
        self.root, self.allocations, self.repos, self.manager, self.gone, self.inspect = root, allocations, repos, manager, gone, inspect
    def save(self, path, value):
        temp = path.with_name(path.name+'.partial')
        fd = os.open(temp,os.O_WRONLY|os.O_CREAT|os.O_TRUNC|os.O_NOFOLLOW,0o600)
        with os.fdopen(fd,'w') as out: json.dump(value,out,sort_keys=True);out.flush();os.fsync(out.fileno())
        os.replace(temp,path);self.sync()
    def sync(self):
        fd=os.open(self.root,os.O_RDONLY|os.O_DIRECTORY)
        try: os.fsync(fd)
        finally: os.close(fd)
    def inventory(self,machine):
        root=self.repos/machine
        if root.resolve()!=root or not root.is_dir(): raise FenceError()
        total=0;count=0;deadline=time.monotonic()+2
        for directory,dirs,files in os.walk(root,followlinks=False):
            for path in [Path(directory)]+[Path(directory)/n for n in files]:
                st=path.lstat();count+=1
                if path.is_symlink(): raise FenceError()
                if count>5000000 or time.monotonic()>deadline: raise TimeoutError()
                total+=max(st.st_size,st.st_blocks*512)
            if any((Path(directory)/n).is_symlink() for n in dirs): raise FenceError()
        return total
    def call(self,action,machine,request):
        rows=[row.split() for row in self.allocations.read_text().splitlines() if row.strip() and not row.startswith('#')]
        if action not in ('stop','status','start') or not re.fullmatch('[a-z0-9][a-z0-9-]{0,63}',machine) or not any(len(r)==3 and r[0]==machine for r in rows): raise FenceError()
        if set(request)!=set(['format','jobId','backend']) or request['format']!=FORMAT or not re.fullmatch('[a-f0-9]{64}',request['jobId']): raise FenceError()
        backend=request['backend']
        if backend is not None and (set(backend)!=set(['pid','birth','bootId']) or not isinstance(backend['pid'],int) or backend['pid']<=0 or not re.fullmatch('linux:[0-9]+',backend['birth']) or not re.fullmatch('[a-f0-9-]{36}',backend['bootId'])): raise FenceError()
        self.root.mkdir(mode=0o700,parents=True,exist_ok=True)
        lock=os.open(self.root/(machine+'.lock'),os.O_RDWR|os.O_CREAT|os.O_NOFOLLOW,0o600)
        try:
            deadline=time.monotonic()+10
            while True:
                try: fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB);break
                except BlockingIOError:
                    if time.monotonic()>deadline: raise FenceError()
                    time.sleep(.02)
            marker=self.root/machine;journal=self.root/(machine+'.json');unit='fleet-backup@'+machine+'.service'
            port=int(next(r[1] for r in rows if r[0]==machine))
            row=json.loads(journal.read_text()) if journal.exists() else None
            if row and row['fenced'] and row.get('ownerUid')!=self.owner_uid: raise FenceError()
            if row and row['fenced'] and row['jobId']!=request['jobId']: raise FenceError()
            if action=='stop':
                if backend is not None: raise FenceError()
                if not row or not row['fenced']:
                    row={'format':FORMAT,'machine':machine,'unit':unit,'jobId':request['jobId'],'backend':None,'ownerUid':self.owner_uid,'fenced':True,'phase':'stopping'}
                    self.save(journal,row)
                fd=os.open(marker,os.O_CREAT|os.O_WRONLY|os.O_NOFOLLOW,0o600);os.fsync(fd);os.close(fd);self.sync()
                state=self.manager('stop',unit)
                if state.get('ActiveState')!='inactive' or state.get('SubState')!='dead': raise FenceError()
                row['phase']='stopped';self.save(journal,row)
            else:
                if (not row or not row['fenced']) and action=='status' and backend is None and not marker.exists():
                    state=self.manager('status',unit)
                    if state.get('ActiveState')!='active' or state.get('SubState')!='running': raise FenceError()
                    if not self.ready(port,machine): raise FenceError()
                    return {'format':FORMAT,'machine':machine,'jobId':request['jobId'],'unit':unit,'writer':'running','activeState':'active','subState':'running','backend':None,'fenced':False,'inventoryBytes':None,'inventoryComplete':False,'ready':True,'phase':'released'}
                if not row or row['jobId']!=request['jobId'] or not row['fenced']: raise FenceError()
                state=self.manager('status',unit)
                if action=='status':
                    if backend is not None:
                        if not marker.exists() or state.get('ActiveState')!='inactive' or state.get('SubState')!='dead': raise FenceError()
                        observed=self.inspect(backend['pid'])
                        if not observed or observed[0]!=backend or observed[1]!=backend['pid'] or len(observed)>2 and observed[2]!=row['ownerUid'] or row['backend'] not in (None,backend): raise FenceError()
                        row['backend']=backend;row['phase']='bound';self.save(journal,row)
                else:
                    if backend!=row['backend']: raise FenceError()
                    if row['backend'] and not self.gone(row['backend']):
                        if not reap_orphans(row['backend'],row['ownerUid']) or not self.gone(row['backend']): raise FenceError()
                    if row['phase']!='restarting' and (state.get('ActiveState')!='inactive' or state.get('SubState')!='dead'): raise FenceError()
                    try: row['inventoryBytes']=self.inventory(machine);row['inventoryComplete']=True
                    except Exception: row['inventoryBytes']=None;row['inventoryComplete']=False
                    row['phase']='restarting';self.save(journal,row)
                    marker.unlink(missing_ok=True);self.sync()
                    try: state=self.manager('start',unit)
                    except Exception:
                        fd=os.open(marker,os.O_CREAT|os.O_WRONLY|os.O_NOFOLLOW,0o600);os.fsync(fd);os.close(fd);self.sync();raise FenceError()
                    if state.get('ActiveState')!='active' or state.get('SubState')!='running' or not self.ready(port,machine):
                        fd=os.open(marker,os.O_CREAT|os.O_WRONLY|os.O_NOFOLLOW,0o600);os.fsync(fd);os.close(fd);self.sync();raise FenceError()
                    row['ready']=True;row['fenced']=False;row['phase']='released';self.save(journal,row)
            row['activeState']=state['ActiveState'];row['subState']=state['SubState'];row['writer']='running' if state['ActiveState']=='active' else 'stopped'
            return row
        finally: os.close(lock)

def authority_uid(value, sudo_uid):
    uid=int(value)
    if uid<=0 or sudo_uid is not None and int(sudo_uid)!=uid: raise FenceError()
    return uid

def main():
    if os.geteuid()!=0 or len(sys.argv)!=3: raise FenceError()
    for path in [Path('/etc/fleet-backup/allocations.tsv'),Path('/etc/fleet-backup/authority.uid'),Path(__file__)]:
        stat=path.stat()
        if stat.st_uid!=0 or stat.st_mode&0o022: raise FenceError()
    directory=Path('/var/lib/fleet-backup/writer-fences');directory.mkdir(mode=0o700,parents=True,exist_ok=True)
    if directory.is_symlink() or directory.stat().st_uid!=0 or directory.stat().st_mode&0o077: raise FenceError()
    owner_uid=authority_uid(Path('/etc/fleet-backup/authority.uid').read_text().strip(),os.environ.get('SUDO_UID'))
    request=json.loads(sys.stdin.read(4097))
    result=WriterFence(owner_uid=owner_uid).call(sys.argv[1],sys.argv[2],request)
    print(json.dumps({k:result[k] for k in ['format','jobId','machine','unit','writer','activeState','subState','backend','fenced','phase']+(['ready'] if 'ready' in result else [])+(['inventoryBytes','inventoryComplete'] if 'inventoryBytes' in result else [])}))
if __name__=='__main__':
    try: main()
    except Exception:
        print(json.dumps({'status':'refused','reason':'writer_fence_failed'}));sys.exit(2)

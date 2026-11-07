import ctypes, os, subprocess, sys
# Only this owned fixture process becomes the wait parent for its descendants.
libc=ctypes.CDLL(None, use_errno=True)
if libc.prctl(36,1,0,0,0)!=0: raise OSError(ctypes.get_errno(),'PR_SET_CHILD_SUBREAPER')
p=subprocess.run(sys.argv[1:])
reaped=[]
while True:
 try:
  pid,status=os.waitpid(-1,os.WNOHANG)
  if pid==0: break
  reaped.append((pid,status))
 except ChildProcessError: break
print('owned subreaper collected',reaped,flush=True)
sys.exit(p.returncode)

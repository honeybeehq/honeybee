#!/usr/bin/env python3
"""Tests the production helper with a disposable manager; never invokes systemctl."""
import importlib.util,json,unittest,tempfile,sys
sys.dont_write_bytecode=True
from pathlib import Path
spec=importlib.util.spec_from_file_location('fence',Path('deploy/backup/fleet-backup-writer-fence.py').resolve());m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class Tests(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory(dir='.audit/backup-b6');self.root=Path(self.temp.name);self.state=self.root/'persistent';self.repos=self.root/'repos';(self.repos/'fixture').mkdir(parents=True);(self.repos/'fixture'/'ciphertext').write_bytes(b'fixture');self.alloc=self.root/'allocations';self.alloc.write_text('fixture 1 100000\n');self.running=True;self.alive=True;self.generation=1;self.identity={'pid':123456,'birth':'linux:123','bootId':'a'*8+'-'+'a'*4+'-'+'a'*4+'-'+'a'*4+'-'+'a'*12};self.request={'format':m.FORMAT,'jobId':'a'*64,'backend':None}
 def tearDown(self):self.temp.cleanup()
 def manager(self,action,unit):
  if action=='stop':
   self.assertTrue((self.state/'fixture').exists(),'durable marker precedes stop');self.running=False
  if action=='start' and not (self.state/'fixture').exists():self.assertFalse(self.alive,'backend absence before start');self.running=True;self.generation+=1
  return {'ActiveState':'active' if self.running else 'inactive','SubState':'running' if self.running else 'dead'}
 def helper(self):return m.WriterFence(root=self.state,allocations=self.alloc,repos=self.repos,manager=self.manager,gone=lambda i:not self.alive,inspect=lambda pid:(self.identity,pid))
 def test_persistent_fence_blocks_boot_and_uncertain_backend(self):
  self.helper().call('stop','fixture',self.request);self.helper().call('status','fixture',{**self.request,'backend':self.identity});self.assertEqual(self.manager('start','fleet-backup@fixture.service')['ActiveState'],'inactive','unit ConditionPathExists keeps enabled writer down after simulated boot');self.assertRaises(m.FenceError,self.helper().call,'start','fixture',{**self.request,'backend':self.identity});self.assertTrue((self.state/'fixture').exists());self.alive=False;value=self.helper().call('start','fixture',{**self.request,'backend':self.identity});self.assertEqual(value['writer'],'running');self.assertGreater(value['inventoryBytes'],0);self.assertEqual(self.generation,2)
 def test_stuck_stop_and_wrong_job_never_clear_marker(self):
  def stuck(action,unit):return {'ActiveState':'active','SubState':'running'}
  helper=m.WriterFence(root=self.state,allocations=self.alloc,repos=self.repos,manager=stuck);self.assertRaises(m.FenceError,helper.call,'stop','fixture',self.request);self.assertTrue((self.state/'fixture').exists());self.assertRaises(m.FenceError,self.helper().call,'start','fixture',{**self.request,'jobId':'b'*64})
 def test_slow_inventory_is_reported_incomplete_without_wedging_writer(self):
  helper=self.helper();helper.call('stop','fixture',self.request);self.alive=False
  def slow(machine):raise TimeoutError()
  helper.inventory=slow;result=helper.call('start','fixture',self.request);self.assertEqual(result['writer'],'running');self.assertFalse(result['inventoryComplete'])
 def test_pinned_nonroot_uid_rejects_environment_mismatch(self):
  self.assertEqual(m.authority_uid('1001','1001'),1001);self.assertEqual(m.authority_uid('1001',None),1001)
  self.assertRaises(m.FenceError,m.authority_uid,'0',None);self.assertRaises(m.FenceError,m.authority_uid,'1001','0')
 def test_foreign_uid_cannot_bind(self):
  helper=self.helper();helper.call('stop','fixture',self.request);helper.inspect=lambda pid:(self.identity,pid,helper.owner_uid+1)
  self.assertRaises(m.FenceError,helper.call,'status','fixture',{**self.request,'backend':self.identity});self.assertTrue((self.state/'fixture').exists())
 def test_unknown_action_machine_and_extra_fields_refuse(self):
  for action,machine,request in [('restart','fixture',self.request),('stop','other',self.request),('stop','fixture',{**self.request,'path':'/tmp'})]:self.assertRaises(m.FenceError,self.helper().call,action,machine,request)
if __name__=='__main__':unittest.main(verbosity=2)

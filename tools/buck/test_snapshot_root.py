import importlib.util, shutil, tempfile, unittest
from pathlib import Path
ROOT=Path(__file__).parent
spec=importlib.util.spec_from_file_location('snapshot_root',ROOT/'snapshot_root.py'); m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
class Tests(unittest.TestCase):
 def test_root_is_ignored_repo_cache_and_cleanup_is_bounded(self):
  repo=Path(tempfile.mkdtemp()); (repo/'.cache').mkdir()
  try:
   snap=m.create(repo)
   self.assertTrue(snap.is_dir()); self.assertTrue((repo/'.cache').resolve() in snap.resolve().parents)
   m.cleanup(repo,snap); self.assertFalse(snap.exists())
   with self.assertRaises(m.SnapshotRootError): m.root_for(repo,'../escape')
  finally: shutil.rmtree(repo)
if __name__=='__main__': unittest.main()

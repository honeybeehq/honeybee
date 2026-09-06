export function seedStore(store, bees, generations = 1) {
  store.transact(() => {
    for (let i = 0; i < bees; i++) {
      const id = `perf-${i}`;
      store.createBee({ id, name: id, handle: `PF.${i}`, agent: 'stub', substrate: 'hsr', cwd: '/tmp' });
      store.updateRuntimeState(id, 1, 'stopped', { exitCause: 'clean' });
      for (let gen = 2; gen <= generations; gen++) {
        const rt = store.reviveBee(id);
        store.updateRuntimeState(id, rt.generation, 'stopped', { exitCause: 'clean' });
      }
      if (i % 10 !== 0) store.archiveBee(id);
    }
  });
}

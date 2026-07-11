// ABOUTME: Creates isolated process-lifecycle cleanup registries without installing global handlers.
// ABOUTME: Lets the executable boundary await exactly the cleanups registered by its command runtime.
export type LifecycleCleanup = () => Promise<void>;
export type LifecycleRegistrar = (cleanup: LifecycleCleanup) => () => void;

export interface LifecycleRegistry {
  register: LifecycleRegistrar;
  cleanup(): Promise<void>;
}

export function createLifecycleRegistry(): LifecycleRegistry {
  const cleanups = new Set<LifecycleCleanup>();
  return {
    register(cleanup) {
      cleanups.add(cleanup);
      return () => cleanups.delete(cleanup);
    },
    async cleanup() {
      const pending = [...cleanups];
      cleanups.clear();
      await Promise.allSettled(pending.map((cleanup) => cleanup()));
    },
  };
}

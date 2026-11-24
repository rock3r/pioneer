/** Entries visited at once by extension filesystem walks. */
const WALK_CONCURRENCY = 32;

/** One directory's children, handed out in order to whichever worker is free. */
export interface WalkLevel<C> {
  readonly size: number;
  readonly child: (index: number) => C;
  next: number;
}

/**
 * Visits a tree with a fixed pool of workers. Pending work is one cursor per open directory,
 * not one task per entry, so a directory with many entries costs no more promises than a
 * small one. After the first failure no new entry starts, and the walk waits for the visits
 * in flight before it rejects, so nothing still writes when the snapshot fails.
 */
export async function walkBounded<C>(
  top: WalkLevel<C>,
  visit: (entry: C) => Promise<WalkLevel<C> | undefined>,
  signal?: AbortSignal,
): Promise<void> {
  const levels: WalkLevel<C>[] = [top];
  let failure: { readonly error: unknown } | undefined;
  let active = 0;
  let changed: PromiseWithResolvers<void> | undefined;
  const notify = (): void => {
    const waiting = changed;
    changed = undefined;
    waiting?.resolve();
  };
  const take = (): C | undefined => {
    for (;;) {
      const level = levels[levels.length - 1];
      if (level === undefined) return undefined;
      if (level.next < level.size) {
        const index = level.next;
        level.next += 1;
        return level.child(index);
      }
      levels.pop();
    }
  };
  const worker = async (): Promise<void> => {
    while (failure === undefined) {
      const entry = take();
      if (entry === undefined) {
        // Another worker may still open a directory; wait for it unless nothing is running.
        if (active === 0) return;
        changed ??= Promise.withResolvers<void>();
        await changed.promise;
        continue;
      }
      active += 1;
      try {
        signal?.throwIfAborted();
        const level = await visit(entry);
        if (level !== undefined && level.size > 0) levels.push(level);
      } catch (error) {
        failure ??= { error };
      } finally {
        active -= 1;
        notify();
      }
    }
  };
  await Promise.all(Array.from({ length: WALK_CONCURRENCY }, worker));
  if (failure !== undefined) throw failure.error;
}

// Blast radius (decision 6): the services that depend on the root cause, directly or transitively.
// A slow callee makes its callers slow, so impact flows against the direction of the call edges.

/** Every transitive caller of `root` over the given call edges (um -> dm). Cycle-safe; excludes root. */
export function transitiveCallers(edges: { um: string; dm: string }[], root: string): string[] {
  const callersOf = new Map<string, string[]>();
  for (const e of edges) {
    if (e.um === e.dm) continue;
    const list = callersOf.get(e.dm);
    if (list) list.push(e.um);
    else callersOf.set(e.dm, [e.um]);
  }
  const seen = new Set<string>([root]);
  const queue = [root];
  while (queue.length > 0) {
    const current = queue.shift() as string;
    for (const caller of callersOf.get(current) ?? []) {
      if (!seen.has(caller)) {
        seen.add(caller);
        queue.push(caller);
      }
    }
  }
  seen.delete(root);
  return [...seen].sort();
}

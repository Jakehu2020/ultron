/**
 * A tiny shared "blackboard" the orchestrator uses to pass state between roles.
 *
 * Agents are intentionally stateless and isolated — they do not know about each
 * other. The coordinator is the only thing that reads/writes this bus, so it is
 * the single point where one role's output becomes another role's context.
 *
 * Keys are namespaced by the writing role to avoid collisions, e.g.
 * `planner.plan`, `coder.summary`, `reviewer.verdict`.
 */
export class MemoryBus {
  constructor(initial = {}) {
    this.store = { ...initial };
  }

  /** Write a value under `role.key`. */
  set(role, key, value) {
    this.store[`${role}.${key}`] = value;
    return value;
  }

  /** Read a value by its fully-qualified `role.key`, or a default. */
  get(role, key, fallback = undefined) {
    const v = this.store[`${role}.${key}`];
    return v === undefined ? fallback : v;
  }

  /** Get the entire raw store (used to build a context digest for a role). */
  snapshot() {
    return { ...this.store };
  }
}

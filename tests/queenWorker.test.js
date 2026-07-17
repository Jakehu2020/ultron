import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createWorkerTools } from "../src/orchestrator/queenWorker.js";

// Fake worker factory that returns a fixed result (or a custom promise).
function makeFakeCreateWorker(runImpl) {
  return (role) => ({
    run: async (task) => {
      const value = await runImpl(role, task);
      return value;
    },
  });
}

const globalConfig = {};
const confirm = async () => true;

describe("createWorkerTools", () => {
  test("sync dispatch returns result and does not add to pending", async () => {
    const fake = makeFakeCreateWorker(async (role, task) => ({
      finalText: `done:${task}`,
      iterations: 1,
    }));
    const [dispatchTool, collectTool] = createWorkerTools({ globalConfig, confirm, createWorker: fake });

    const res = await dispatchTool.execute({ role: "coder", task: "t1" });
    assert.equal(typeof res.id, "string");
    assert.equal(res.role, "coder");
    assert.match(res.result, /done:.*t1/);
    assert.equal(res.iterations, 1);

    // Sync dispatch never touches pending => collect returns nothing.
    const collected = await collectTool.execute({});
    assert.deepEqual(collected.workers, []);
  });

  test("async dispatch + collect while pending (never-resolving worker)", async () => {
    const fake = makeFakeCreateWorker(async () => new Promise(() => {}));
    const [dispatchTool, collectTool] = createWorkerTools({ globalConfig, confirm, createWorker: fake });

    const dispatched = await dispatchTool.execute({ role: "coder", task: "t2", background: true });
    assert.equal(dispatched.status, "dispatched");

    const first = await collectTool.execute({});
    assert.equal(first.workers.length, 1);
    assert.equal(first.workers[0].status, "pending");

    const second = await collectTool.execute({});
    assert.equal(second.workers.length, 1, "pending worker should still be present");
    assert.equal(second.workers[0].status, "pending");
  });

  test("async dispatch + collect complete, then pruned on next collect", async () => {
    const fake = makeFakeCreateWorker(async () => ({ finalText: "done", iterations: 2 }));
    const [dispatchTool, collectTool] = createWorkerTools({ globalConfig, confirm, createWorker: fake });

    await dispatchTool.execute({ role: "coder", task: "t3", background: true });
    // Let the worker finish.
    await new Promise((r) => setTimeout(r, 10));

    const first = await collectTool.execute({});
    assert.equal(first.workers.length, 1);
    assert.equal(first.workers[0].status, "complete");
    assert.equal(first.workers[0].result, "done");
    assert.equal(first.workers[0].iterations, 2);

    // Second collection should find it pruned.
    const second = await collectTool.execute({});
    assert.deepEqual(second.workers, []);
  });

  test("run history records dispatches", async () => {
    const fake = makeFakeCreateWorker(async (role, task) => ({
      finalText: `done:${task}`,
      iterations: 1,
    }));
    const [dispatchTool] = createWorkerTools({ globalConfig, confirm, createWorker: fake });

    await dispatchTool.execute({ role: "coder", task: "t4" });
    const history = dispatchTool.getRunHistory();
    assert.ok(history.length >= 1);
    const entry = history.find((h) => h.task === "t4");
    assert.ok(entry, "history should include the dispatched task");
    assert.equal(entry.role, "coder");
    assert.equal(entry.task, "t4");
    assert.equal(entry.iterations, 1);
  });
});

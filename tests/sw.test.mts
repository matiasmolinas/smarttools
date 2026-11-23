// The service worker (public/sw.js): the engine comes from the network first, so a deploy always brings its own
// engine; the cached copy is used offline or when the network is slow, and a late answer still updates the cache.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const SRC = readFileSync(new URL("../public/sw.js", import.meta.url), "utf8");
const ORIGIN = "https://app.test";
const tick = () => new Promise((r) => setImmediate(r));

/** Loads sw.js with fake caches, fetch and timers. fetchImpl decides each network answer. */
function worker(fetchImpl: (url: string) => Promise<Response>) {
  const stores = new Map<string, Map<string, Response>>();
  const key = (r: Request | string) => new URL(typeof r === "string" ? r : r.url, ORIGIN).href;
  const open = async (name: string) => {
    if (!stores.has(name)) stores.set(name, new Map());
    const m = stores.get(name)!;
    return {
      match: async (r: Request | string) => m.get(key(r))?.clone(),
      put: async (r: Request | string, res: Response) => void m.set(key(r), res),
      add: async () => {},
    };
  };
  const timers: (() => void)[] = [];
  const handlers: Record<string, (e: unknown) => void> = {};
  const ctx = {
    self: { location: { origin: ORIGIN }, addEventListener: (t: string, h: (e: unknown) => void) => (handlers[t] = h), skipWaiting: async () => {}, clients: { claim: async () => {} } },
    caches: { open, keys: async () => [...stores.keys()], delete: async (n: string) => stores.delete(n) },
    fetch: (r: Request | string) => fetchImpl(key(r)),
    setTimeout: (fn: (...a: unknown[]) => void, _ms: number, ...a: unknown[]) => timers.push(() => fn(...a)),
    clearTimeout: () => {},
    URL,
    Response,
    Promise,
  };
  vm.runInNewContext(SRC, ctx);
  const version = /const VERSION = "([^"]+)"/.exec(SRC)![1];

  async function get(path: string) {
    let responded: Promise<Response | undefined> | undefined;
    const waits: Promise<unknown>[] = [];
    handlers.fetch({ request: new Request(ORIGIN + path), respondWith: (p: Promise<Response>) => (responded = p), waitUntil: (p: Promise<unknown>) => waits.push(p) });
    return { responded, waits };
  }
  return { get, timers, cached: async (path: string) => (await open(version)).match(ORIGIN + path), seed: async (path: string, body: string) => (await open(version)).put(ORIGIN + path, new Response(body)), version };
}

test("the cache version is bumped so phones drop the old engine", () => {
  assert.match(SRC, /const VERSION = "st-v2"/);
});

test("the engine: the network answer wins and refreshes the cache", async () => {
  const w = worker(async () => new Response("new engine"));
  await w.seed("/engine/nav_core.wasm", "old engine");
  const { responded, waits } = await w.get("/engine/nav_core.wasm");
  assert.equal(await (await responded)!.text(), "new engine");
  await Promise.all(waits);
  await tick();
  assert.equal(await (await w.cached("/engine/nav_core.wasm"))!.text(), "new engine");
});

test("the engine offline: the cached copy, and no unhandled rejection", async () => {
  const w = worker(async () => {
    throw new TypeError("Failed to fetch");
  });
  await w.seed("/engine/nav_core.wasm", "old engine");
  const { responded, waits } = await w.get("/engine/nav_core.wasm");
  assert.equal(await (await responded)!.text(), "old engine");
  await Promise.all(waits); // every lifetime promise settles without throwing
});

test("the engine slow: after the timeout the cached copy, and the late answer still updates the cache", async () => {
  let answer!: (r: Response) => void;
  const w = worker(() => new Promise((r) => (answer = r)));
  await w.seed("/engine/nav_core.wasm", "old engine");
  const { responded, waits } = await w.get("/engine/nav_core.wasm");
  await tick();
  assert.equal(w.timers.length, 1, "one timeout armed");
  w.timers[0]();
  assert.equal(await (await responded)!.text(), "old engine");
  answer(new Response("new engine"));
  await Promise.all(waits);
  await tick();
  await Promise.all(waits);
  assert.equal(await (await w.cached("/engine/nav_core.wasm"))!.text(), "new engine");
});

test("the engine slow and never cached: it waits for the network", async () => {
  let answer!: (r: Response) => void;
  const w = worker(() => new Promise((r) => (answer = r)));
  const { responded } = await w.get("/engine/nav_core.wasm");
  await tick();
  w.timers[0]();
  await tick();
  answer(new Response("new engine"));
  assert.equal(await (await responded)!.text(), "new engine");
});

test("models stay stale-while-revalidate: the cached copy at once", async () => {
  const w = worker(async () => new Response("new model"));
  await w.seed("/models/a.bin", "old model");
  const { responded } = await w.get("/models/a.bin");
  assert.equal(await (await responded)!.text(), "old model");
  assert.equal(w.timers.length, 0);
});

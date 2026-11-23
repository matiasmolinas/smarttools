// Local memory (docs/ARCHITECTURE.md §2): the phone keeps its plans and jobs in IndexedDB, so the app works with
// no network and nothing is lost between sessions. Every write is also in the outbox until a sync (F2) marks
// it as uploaded. Plans are validated on the way in, whatever their source (the pointer, an imported file).
// Tests use the in-memory backend; the browser uses IndexedDB.

import { validatePlan, type Plan } from "./plan.ts";
import { JOB_KIND, type JobRecord } from "./jobrecord.ts";
import { isBenchRun, type BenchRun } from "./bench.ts";

export type Store = "plans" | "jobs" | "bench";
export interface Row<T> {
  id: string;
  value: T;
  /** ISO time of the last local change */
  updated: string;
  /** false until the cloud has it (F2) */
  synced: boolean;
}

export interface Backend {
  all<T>(store: Store): Promise<Row<T>[]>;
  get<T>(store: Store, id: string): Promise<Row<T> | undefined>;
  put<T>(store: Store, row: Row<T>): Promise<void>;
  del(store: Store, id: string): Promise<void>;
}

export class MemBackend implements Backend {
  private data: Record<Store, Map<string, Row<unknown>>> = { plans: new Map(), jobs: new Map(), bench: new Map() };
  async all<T>(s: Store) {
    return [...this.data[s].values()].map((r) => structuredClone(r)) as Row<T>[];
  }
  async get<T>(s: Store, id: string) {
    const r = this.data[s].get(id);
    return r ? (structuredClone(r) as Row<T>) : undefined;
  }
  async put<T>(s: Store, row: Row<T>) {
    this.data[s].set(row.id, structuredClone(row) as Row<unknown>);
  }
  async del(s: Store, id: string) {
    this.data[s].delete(id);
  }
}

const DB = "smarttools";
const DB_VERSION = 2; // 2: the bench lab's runs

export class IdbBackend implements Backend {
  private db: Promise<IDBDatabase>;
  constructor(idb: IDBFactory = indexedDB) {
    this.db = new Promise((resolve, reject) => {
      const req = idb.open(DB, DB_VERSION);
      req.onupgradeneeded = () => {
        for (const s of ["plans", "jobs", "bench"]) if (!req.result.objectStoreNames.contains(s)) req.result.createObjectStore(s, { keyPath: "id" });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  private async run<R>(s: Store, mode: IDBTransactionMode, f: (os: IDBObjectStore) => IDBRequest): Promise<R> {
    const db = await this.db;
    return new Promise((resolve, reject) => {
      const req = f(db.transaction(s, mode).objectStore(s));
      req.onsuccess = () => resolve(req.result as R);
      req.onerror = () => reject(req.error);
    });
  }
  all<T>(s: Store) {
    return this.run<Row<T>[]>(s, "readonly", (os) => os.getAll());
  }
  get<T>(s: Store, id: string) {
    return this.run<Row<T> | undefined>(s, "readonly", (os) => os.get(id));
  }
  async put<T>(s: Store, row: Row<T>) {
    await this.run(s, "readwrite", (os) => os.put(row));
  }
  async del(s: Store, id: string) {
    await this.run(s, "readwrite", (os) => os.delete(id));
  }
}

const newest = <T>(rows: Row<T>[]) => rows.sort((a, b) => b.updated.localeCompare(a.updated));

export class LocalMemory {
  readonly backend: Backend;
  constructor(backend: Backend) {
    this.backend = backend;
  }

  async plans(): Promise<Row<Plan>[]> {
    return newest(await this.backend.all<Plan>("plans"));
  }
  async plan(id: string) {
    return (await this.backend.get<Plan>("plans", id))?.value;
  }
  /** Save a plan. Anything that is not a valid plan is refused with the reasons. */
  async savePlan(p: unknown): Promise<{ ok: true; plan: Plan } | { ok: false; errors: string[] }> {
    const c = validatePlan(p);
    if (!c.ok) return c;
    await this.backend.put("plans", { id: c.plan.id, value: c.plan, updated: c.plan.updated, synced: false });
    return c;
  }
  deletePlan(id: string) {
    return this.backend.del("plans", id);
  }

  async jobs(): Promise<Row<JobRecord>[]> {
    return newest(await this.backend.all<JobRecord>("jobs"));
  }
  async job(id: string) {
    return (await this.backend.get<JobRecord>("jobs", id))?.value;
  }
  async saveJob(j: JobRecord) {
    if (j.kind !== JOB_KIND) throw new Error("not a SmartTools job record");
    await this.backend.put("jobs", { id: j.id, value: j, updated: j.ended, synced: false });
  }
  deleteJob(id: string) {
    return this.backend.del("jobs", id);
  }

  async benchRuns(): Promise<Row<BenchRun>[]> {
    return newest(await this.backend.all<BenchRun>("bench"));
  }
  async saveBenchRun(r: BenchRun) {
    if (!isBenchRun(r)) throw new Error("not a SmartTools bench run");
    await this.backend.put("bench", { id: r.id, value: r, updated: r.created, synced: false });
  }
  deleteBenchRun(id: string) {
    return this.backend.del("bench", id);
  }

  /** What the cloud does not have yet (F2 uploads it, then calls markSynced). */
  async outbox() {
    const [p, j] = await Promise.all([this.backend.all("plans"), this.backend.all("jobs")]);
    return { plans: p.filter((r) => !r.synced).map((r) => r.id), jobs: j.filter((r) => !r.synced).map((r) => r.id) };
  }
  async markSynced(store: Store, id: string) {
    const r = await this.backend.get(store, id);
    if (r) await this.backend.put(store, { ...r, synced: true });
  }
}

/** The browser's memory (IndexedDB), created once. Asks the browser to keep it (not evict it under pressure). */
let shared: LocalMemory | null = null;
export function browserMemory(): LocalMemory {
  if (!shared) {
    shared = new LocalMemory(new IdbBackend());
    void navigator.storage?.persist?.().catch(() => {});
  }
  return shared;
}

// the plan the app works with, remembered per device
const ACTIVE = "st-plan";
export function activePlanId(): string | null {
  try {
    return localStorage.getItem(ACTIVE);
  } catch {
    return null;
  }
}
export function setActivePlanId(id: string | null) {
  try {
    if (id) localStorage.setItem(ACTIVE, id);
    else localStorage.removeItem(ACTIVE);
  } catch {}
}

// the job in progress, written after every finished hole: if the page dies (iOS discards it in the background),
// the next start finds it here. A clean end (saved, or stopped without saving) clears it.
const DRAFT = "st-job-draft";
type DraftStore = Pick<Storage, "getItem" | "setItem" | "removeItem">;
export function readJobDraft(store?: DraftStore): JobRecord | null {
  try {
    const raw = (store ?? localStorage).getItem(DRAFT);
    if (!raw) return null;
    const j = JSON.parse(raw) as JobRecord;
    return j && j.kind === JOB_KIND && typeof j.id === "string" && Array.isArray(j.holes) && typeof j.plan?.id === "string" ? j : null;
  } catch {
    return null;
  }
}
export function writeJobDraft(j: JobRecord, store?: DraftStore) {
  try {
    (store ?? localStorage).setItem(DRAFT, JSON.stringify(j));
  } catch {}
}
export function clearJobDraft(store?: DraftStore) {
  try {
    (store ?? localStorage).removeItem(DRAFT);
  } catch {}
}

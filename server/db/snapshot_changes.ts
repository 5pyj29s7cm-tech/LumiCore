import { createHash } from 'node:crypto';

const targets = new WeakMap<object, any>();
export const databaseTarget = <T>(value: T): T => value && typeof value === 'object' ? targets.get(value) || value : value;
const plain = (value: any) => value && typeof value === 'object' && (Array.isArray(value) || [Object.prototype, null].includes(Object.getPrototypeOf(value)));

/** Native structuredClone cannot accept a Proxy; preserve clone semantics for database views. */
export function cloneDatabaseValue<T>(input: T): T {
  const seen = new Map<any, any>();
  const copy = (value: any): any => {
    value = databaseTarget(value);
    if (!value || typeof value !== 'object') return value;
    if (seen.has(value)) return seen.get(value);
    if (value instanceof Map || value instanceof Set) {
      const output = value instanceof Map ? new Map() : new Set(); seen.set(value, output);
      if (value instanceof Map) for (const [key, item] of value) (output as Map<any, any>).set(copy(key), copy(item));
      else for (const item of value) (output as Set<any>).add(copy(item));
      return output;
    }
    if (!plain(value)) return value;
    const output = Array.isArray(value) ? new Array(value.length) : {};
    seen.set(value, output);
    for (const key of Object.keys(value)) Object.defineProperty(output, key, { value: copy(value[key]), enumerable: true, configurable: true, writable: true });
    return output;
  };
  return globalThis.structuredClone(copy(input));
}

export interface SnapshotProjection {
  name: string;
  source?: string;
  dependencies?: string[];
  extraRows?: () => Iterable<any[]>;
  rows: (items?: any[]) => Iterable<any[]>;
}
type Watch = { change: () => void; escape: () => void };
type Node = { proxy?: WeakRef<object>; watches: Set<Watch> };
type ArrayWatch = { change: (key: PropertyKey, old: any, next: any, removed: any[]) => void; escape: () => void };
const copyingArrayMethods = new Set(['filter', 'slice', 'map', 'concat', 'flat', 'flatMap', 'toReversed', 'toSorted', 'toSpliced', 'with']);
const digest = (value: any) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const arrayIndex = (key: PropertyKey) => typeof key === 'string' && /^(0|[1-9][0-9]*)$/.test(key) && Number(key) < 4294967295;

/** Loaded objects are owned here. Caller-owned aliases remain conservatively compared. */
export class DatabaseSnapshots {
  private nodes = new WeakMap<object, Node>();
  private arrays = new WeakMap<object, { proxy: any; watches: Set<ArrayWatch> }>();
  private tables = new Map<string, TableChanges>();
  private sourceTables = new Map<string, TableChanges>();
  private raw: any;
  private externalRoot = false;
  view: any;
  comparedRows = 0;
  scannedRows = 0;

  constructor(root: any, specs: SnapshotProjection[]) {
    this.raw = root;
    for (const spec of specs) {
      const table = new TableChanges(spec, this);
      this.tables.set(spec.name, table);
      for (const source of [...(spec.source ? [spec.source] : []), ...spec.dependencies || []]) this.sourceTables.set(source, table);
    }
    for (const [source, table] of this.sourceTables) table.assign(source, root[source], true);
    this.view = this.rootView();
    const initial = this.capture();
    initial.commit();
  }

  observe(value: any, watch: Watch, owned = false, seen = new Set<any>()): void {
    value = databaseTarget(value);
    if (!value || typeof value !== 'object' || seen.has(value)) return;
    seen.add(value);
    if (!plain(value)) { watch.escape(); return; }
    let node = this.nodes.get(value);
    if (!node) {
      if (!owned) { watch.escape(); return; }
      node = { watches: new Set() };
      this.nodes.set(value, node);
    }
    if (node.watches.has(watch)) return;
    node.watches.add(watch);
    for (const key of Object.keys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
      if (descriptor.get || descriptor.set) watch.escape();
      this.observe(value[key], watch, owned, seen);
    }
  }

  expose(value: any): any {
    const raw = databaseTarget(value), array = this.arrays.get(raw);
    if (array) return array.proxy;
    const node = this.nodes.get(raw);
    if (!node) return value;
    const existing = node.proxy?.deref();
    if (existing) return existing;
    const proxy = this.proxy(raw, key => this.expose(raw[key]), (_key, _old, next) => {
      for (const listener of node.watches) { listener.change(); this.observe(next, listener); }
    }, () => { for (const listener of node.watches) listener.escape(); });
    node.proxy = new WeakRef(proxy);
    return proxy;
  }
  ownsArray(value: any): boolean { return this.arrays.has(databaseTarget(value)); }

  array(value: any[], watch?: ArrayWatch): any[] {
    let node = this.arrays.get(value);
    if (!node) {
      const watches = new Set<ArrayWatch>(), methods = new Map<PropertyKey, Function>(), tracker = this;
      const proxy = this.proxy(value, key => {
        if (!copyingArrayMethods.has(String(key)) || value[key as any] !== (Array.prototype as any)[key]) return this.expose(value[key as any]);
        if (!methods.has(key)) methods.set(key, function(this: any, ...args: any[]) { return tracker.array(Reflect.apply((Array.prototype as any)[key], this, args)); });
        return methods.get(key);
      }, (key, old, next, removed) => { for (const listener of watches) listener.change(key, old, next, removed); },
      () => { for (const listener of watches) listener.escape(); });
      node = { proxy, watches }; this.arrays.set(value, node);
    }
    if (watch) node.watches.add(watch);
    return node.proxy;
  }

  proxy(target: any, get: (key: PropertyKey) => any, change: (key: PropertyKey, old: any, next: any, removed: any[]) => void, escape: () => void): any {
    const read = (key: PropertyKey) => {
      const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
      if (descriptor && !descriptor.configurable && 'value' in descriptor && !descriptor.writable) { escape(); return descriptor.value; }
      return get(key);
    };
    const mutate = (key: PropertyKey, operation: () => boolean, length?: unknown) => {
      const old = target[key], removed = Array.isArray(target) && key === 'length' && Number(length) < target.length ? target.slice(Number(length)) : [];
      const result = operation();
      if (result) change(key, old, target[key], removed);
      return result;
    };
    const proxy = new Proxy(target, {
      get: (_target, key) => read(key),
      getOwnPropertyDescriptor: (_target, key) => {
        const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
        return descriptor && 'value' in descriptor ? { ...descriptor, value: read(key) } : descriptor;
      },
      set: (_target, key, value) => mutate(key, () => Reflect.set(target, key, value, target), value),
      deleteProperty: (_target, key) => mutate(key, () => Reflect.deleteProperty(target, key)),
      defineProperty: (_target, key, descriptor) => { if (descriptor.get || descriptor.set) escape(); return mutate(key, () => Reflect.defineProperty(target, key, descriptor), descriptor.value); },
      setPrototypeOf: (_target, prototype) => { escape(); return Reflect.setPrototypeOf(target, prototype); },
    });
    targets.set(proxy, target);
    return proxy;
  }

  private rootView(): any {
    const root = this.raw;
    return this.proxy(root, key => {
      const table = this.sourceTables.get(String(key));
      return table ? table.expose(String(key), root[key]) : root[key];
    }, key => {
      if (root === this.raw) this.sourceTables.get(String(key))?.assign(String(key), root[key]);
    }, () => { if (root === this.raw) this.externalRoot = true; });
  }

  adopt(root: any): void {
    root = databaseTarget(root);
    if (root === this.raw) return;
    this.raw = root; this.externalRoot = true;
    for (const [source, table] of this.sourceTables) table.assign(source, root[source]);
    this.view = this.rootView();
  }

  capture() {
    this.comparedRows = this.scannedRows = 0;
    if (this.externalRoot) for (const [source, table] of this.sourceTables) table.assign(source, this.raw[source]);
    // Nothing is consumed until every projection succeeds, before the first SQL await.
    const captures = [...this.tables.values()].map(table => table.capture());
    for (const table of this.tables.values()) table.clear();
    return {
      total: this.tables.size,
      tables: captures.filter(capture => capture.rows.length || capture.deletions?.length || capture.replace),
      commit: () => { for (const capture of captures) capture.commit(); },
      rollback: () => { for (const capture of captures) capture.rollback(); },
    };
  }
}

class TableChanges {
  private container: any;
  private containerView: any;
  private arrayListeners = new WeakMap<object, ArrayWatch>();
  private unsafeContainer = false;
  private counts = new Map<any, number>();
  private activeCount = 0;
  private changed = new Set<any>();
  private escaped = new Set<any>();
  private sources = new Map<string, any>();
  private dirty = true;
  private unsafe = false;
  private durable = new Map<string, string>();
  private rowKeys = new Map<any, string>();
  private legacy = false;
  private fullDigest = '';
  private extraKeys = new Set<string>();

  constructor(readonly spec: SnapshotProjection, private tracker: DatabaseSnapshots) {}

  assign(source: string, value: any, owned = false): void {
    if (this.sources.has(source) && this.sources.get(source) === value) return;
    this.sources.set(source, value); this.dirty = true;
    if (source !== this.spec.source) {
      this.tracker.observe(value, { change: () => { this.dirty = true; }, escape: () => { this.unsafe = true; } }, owned);
      return;
    }
    this.container = databaseTarget(value);
    this.unsafeContainer = !owned && !this.tracker.ownsArray(value);
    this.sync(owned);
    if (this.unsafeContainer || !Array.isArray(this.container)) { this.containerView = value; return; }
    const array = this.container;
    let listener = this.arrayListeners.get(array);
    if (!listener) {
      listener = {
        change: (key, old, next, removed) => {
          if (array !== this.container) return;
          if (arrayIndex(key)) { this.count(old, -1); this.count(next, 1); }
          else if (key === 'length') for (const row of removed) this.count(row, -1);
        },
        escape: () => { if (array === this.container) this.unsafeContainer = true; },
      };
      this.arrayListeners.set(array, listener);
    }
    this.containerView = this.tracker.array(array, listener);
  }

  expose(source: string, value: any): any {
    return this.spec.source === source && this.sources.get(source) === value ? this.containerView : this.tracker.expose(value);
  }

  private count(value: any, delta: number, owned = false): void {
    const row = databaseTarget(value);
    if (row === undefined) return;
    const before = this.counts.get(row) || 0, count = before + delta;
    this.changed.add(row);
    this.activeCount += Math.max(0, count) - before;
    if (count > 0) this.counts.set(row, count);
    else { this.counts.delete(row); this.escaped.delete(row); }
    if (delta > 0 && !before) {
      this.tracker.observe(row, new RowWatch(this, row), owned);
    }
  }

  mark(row: any, escaped = false): void { (escaped ? this.escaped : this.changed).add(row); }

  private sync(owned = false): void {
    const next = new Map<any, number>();
    for (const value of this.container || []) { this.tracker.scannedRows++; const row = databaseTarget(value); next.set(row, (next.get(row) || 0) + 1); }
    for (const [row, count] of this.counts) if (!next.has(row)) this.count(row, -count);
    for (const [row, count] of next) if (count !== (this.counts.get(row) || 0)) this.count(row, count - (this.counts.get(row) || 0), owned);
  }

  clear(): void { this.changed = new Set(); this.dirty = false; }

  capture() {
    if (this.unsafeContainer) this.sync();
    if (this.spec.source && Array.isArray(this.container) && this.container.length !== this.activeCount) throw new Error('Invalid sparse database table: ' + this.spec.name);
    const candidates = new Set([...this.changed, ...this.escaped]);
    const full = !this.spec.source || this.legacy;
    const extras = Boolean(this.spec.extraRows && (this.dirty || this.unsafe));
    const check = full ? this.dirty || this.unsafe || candidates.size > 0 : candidates.size > 0 || extras;
    const nextExtraKeys = new Set<string>();
    const changes = new Map<string, string | null>();
    const nextKeys = new Map<any, string>();
    const rows: any[][] = [];
    const deletions: string[][] = [];
    let replace = false, fullDigest = this.fullDigest, legacy = this.legacy;
    const removed = new Set<string>();
    if (check) {
      if (full) for (const id of this.durable.keys()) removed.add(id);
      else for (const row of candidates) { const id = this.rowKeys.get(row); if (id !== undefined) removed.add(id); }
      if (extras) for (const id of this.extraKeys) removed.add(id);
      for (const id of removed) changes.set(id, null);
      const projected: { owner: any; row: any[] }[] = [];
      if (full) {
        for (const row of this.spec.rows()) projected.push({ owner: null, row });
        if (this.spec.source) { const owners = [...(this.container || [])]; projected.forEach((item, index) => { item.owner = databaseTarget(owners[index]); }); }
      } else {
        for (const owner of candidates) if (this.counts.has(owner)) {
          if (this.counts.get(owner)! > 1) throw new Error('UNIQUE constraint failed in snapshot primary key');
          for (const row of this.spec.rows([owner])) projected.push({ owner, row });
        }
      }
      if (extras && !full) for (const row of this.spec.extraRows!()) projected.push({ owner: null, row });
      this.tracker.comparedRows += projected.length;
      legacy = ['voice_profiles', 'founder_vision'].includes(this.spec.name) || projected.some(({ row }) => typeof row[0] !== 'string' || !row[0]);
      // Malformed legacy keys retain exact atomic table replacement, until repaired.
      if (legacy) {
        const all = full ? projected.map(item => item.row) : [...this.spec.rows()];
        if (!full) this.tracker.comparedRows += all.length;
        fullDigest = digest(all); replace = fullDigest !== this.fullDigest || !this.legacy;
        if (replace) rows.push(...all);
        changes.clear();
      } else {
        for (const { owner, row } of projected) {
          const id = row[0];
          if (changes.get(id) || (this.durable.has(id) && !removed.has(id))) throw new Error('UNIQUE constraint failed in snapshot primary key');
          const hash = digest(row);
          changes.set(id, hash);
          if (owner) nextKeys.set(owner, id); else nextExtraKeys.add(id);
          if (this.legacy || this.durable.get(id) !== hash) rows.push(row);
        }
        for (const [id, value] of changes) if (!value) deletions.push([id]);
        replace = this.legacy;
      }
    }
    return {
      spec: this.spec, rows, deletions: replace ? null : deletions, replace,
      commit: () => {
        if (!check) return;
        if (full || legacy) { this.durable.clear(); this.rowKeys.clear(); }
        else for (const row of candidates) this.rowKeys.delete(row);
        for (const [id, value] of changes) { if (value) this.durable.set(id, value); else this.durable.delete(id); }
        for (const [row, id] of nextKeys) this.rowKeys.set(row, id);
        if (extras || full) this.extraKeys = nextExtraKeys;
        this.legacy = legacy; this.fullDigest = fullDigest;
      },
      rollback: () => { this.dirty ||= check; for (const row of candidates) this.changed.add(row); },
    };
  }
}

class RowWatch implements Watch {
  constructor(private table: TableChanges, private row: any) {}
  change(): void { this.table.mark(this.row); }
  escape(): void { this.table.mark(this.row, true); }
}

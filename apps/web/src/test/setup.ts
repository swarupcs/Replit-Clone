/** Minimal localStorage for the node test environment.
 *
 *  The stores that persist preferences and workspace layout reach for it at
 *  import time; without one, zustand's persist middleware warns on every write
 *  and the persistence path is never actually exercised by the tests.
 */
class MemoryStorage implements Storage {
  private entries = new Map<string, string>();

  get length(): number {
    return this.entries.size;
  }

  clear(): void {
    this.entries.clear();
  }

  getItem(key: string): string | null {
    return this.entries.get(key) ?? null;
  }

  key(index: number): string | null {
    return [...this.entries.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.entries.delete(key);
  }

  setItem(key: string, value: string): void {
    this.entries.set(key, value);
  }
}

globalThis.localStorage = new MemoryStorage();

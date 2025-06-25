import { LRUCache } from "lru-cache";

// biome-ignore lint/suspicious/noExplicitAny: <explanation>
export class LRUCacheWrapper extends LRUCache<any, any> {
  // biome-ignore lint/suspicious/noExplicitAny: <explanation>
  del(k: any): boolean {
    return this.delete(k);
  }

  flushAll(): void {
    this.clear();
  }
}

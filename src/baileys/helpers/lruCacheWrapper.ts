import { LRUCache } from "lru-cache";

// biome-ignore lint/suspicious/noExplicitAny: LRUCache interface is too complex to type easily
export class LRUCacheWrapper extends LRUCache<any, any> {
  // biome-ignore lint/suspicious/noExplicitAny: LRUCache interface is too complex to type easily
  del(k: any): boolean {
    return this.delete(k);
  }

  flushAll(): void {
    this.clear();
  }
}

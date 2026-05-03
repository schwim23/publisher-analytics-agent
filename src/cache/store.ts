import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';

export const TTL = {
  DELIVERY_TODAY: 30 * 60,
  DELIVERY_HISTORY: 6 * 3600,
} as const;

interface CacheEntry<T> {
  data: T;
  refreshedAt: string;
  expiresAt: string;
}

export class ReportCache {
  readonly dir: string;

  constructor(cacheDir?: string) {
    this.dir = cacheDir ?? join(process.env.HOME ?? homedir(), '.publisher-analytics', 'cache');
    mkdirSync(this.dir, { recursive: true });
  }

  private filePath(key: string): string {
    return join(this.dir, `${key.replace(/[^a-zA-Z0-9_-]/g, '_')}.json`);
  }

  get<T>(key: string): { data: T; refreshedAt: string; isStale: boolean } | null {
    try {
      const entry = JSON.parse(readFileSync(this.filePath(key), 'utf-8')) as CacheEntry<T>;
      return {
        data: entry.data,
        refreshedAt: entry.refreshedAt,
        isStale: new Date(entry.expiresAt) < new Date(),
      };
    } catch {
      return null;
    }
  }

  set<T>(key: string, data: T, ttlSeconds: number): void {
    const now = new Date();
    const entry: CacheEntry<T> = {
      data,
      refreshedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + ttlSeconds * 1000).toISOString(),
    };
    const tmp = join(tmpdir(), `pa-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`);
    writeFileSync(tmp, JSON.stringify(entry), 'utf-8');
    renameSync(tmp, this.filePath(key));
  }
}

export function deliveryTTL(endDate: string): number {
  const isToday = new Date(endDate).toDateString() === new Date().toDateString();
  return isToday ? TTL.DELIVERY_TODAY : TTL.DELIVERY_HISTORY;
}

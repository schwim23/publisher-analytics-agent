import type { DataClient } from '../data-client.js';

const REFRESH_INTERVAL_MS = 30 * 60 * 1000;

function log(msg: string) {
  process.stderr.write(`[publisher-analytics cache] ${new Date().toISOString()} ${msg}\n`);
}

function todayAndYesterday(): [string, string] {
  const today = new Date().toISOString().split('T')[0];
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().split('T')[0];
  return [today, yesterday];
}

export class CacheScheduler {
  private client: DataClient;
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(client: DataClient) {
    this.client = client;
  }

  start(): void {
    if (!this.client.refreshDeliveryCache) return;
    setImmediate(() => this.refresh('startup warm-up'));
    this.timer = setInterval(() => this.refresh('scheduled refresh'), REFRESH_INTERVAL_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async refresh(reason: string): Promise<void> {
    if (!this.client.refreshDeliveryCache) return;
    if (this.running) return;
    this.running = true;
    log(`Starting ${reason}`);

    const [today, yesterday] = todayAndYesterday();

    try {
      await this.client.refreshDeliveryCache({ start: yesterday, end: yesterday });
      log(`Cached yesterday (${yesterday})`);

      await this.client.refreshDeliveryCache({ start: today, end: today });
      log(`Cached today (${today})`);
    } catch (err) {
      log(`Failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.running = false;
    }
  }
}

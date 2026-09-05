/**
 * In-process publish/subscribe with a replay buffer, backing the SSE stream.
 *
 * Scope, stated honestly: this is a single-process hub. It is the right answer
 * for one web instance and it is deliberately behind an interface that a Redis
 * pub/sub implementation slots into unchanged — see docs/SCALING.md. What it
 * does provide today is the part that is easy to get wrong: a bounded replay
 * buffer so a client that reconnects with `Last-Event-ID` resumes instead of
 * silently missing whatever happened while its train went through a tunnel.
 */

export interface HubMessage {
  id: number;
  topic: string;
  event: string;
  data: unknown;
  at: number;
}

type Listener = (msg: HubMessage) => void;

const REPLAY_LIMIT = 512;

class EventHub {
  private listeners = new Set<Listener>();
  private buffer: HubMessage[] = [];
  private lastId = 0;

  publish(topic: string, event: string, data: unknown, id?: number): HubMessage {
    this.lastId = Math.max(this.lastId + 1, id ?? 0);
    const msg: HubMessage = { id: this.lastId, topic, event, data, at: Date.now() };
    this.buffer.push(msg);
    if (this.buffer.length > REPLAY_LIMIT) this.buffer.splice(0, this.buffer.length - REPLAY_LIMIT);
    for (const l of this.listeners) {
      try {
        l(msg);
      } catch {
        // A broken subscriber must not stop delivery to the others.
      }
    }
    return msg;
  }

  /** Messages after `afterId` still held in the replay buffer. */
  replay(afterId: number): HubMessage[] {
    if (afterId <= 0) return [];
    return this.buffer.filter((m) => m.id > afterId);
  }

  /** True when a reconnecting client asked for an id we no longer hold. */
  hasGap(afterId: number): boolean {
    if (afterId <= 0 || this.buffer.length === 0) return false;
    return afterId < this.buffer[0].id - 1;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  get subscriberCount(): number {
    return this.listeners.size;
  }

  get currentId(): number {
    return this.lastId;
  }
}

declare global {
  var __tidemarkHub: EventHub | undefined;
}

export function hub(): EventHub {
  globalThis.__tidemarkHub ??= new EventHub();
  return globalThis.__tidemarkHub;
}

/** Topic helpers so the string format lives in exactly one place. */
export const topics = {
  instrument: (id: string) => `instrument:${id}`,
  system: () => "system",
};

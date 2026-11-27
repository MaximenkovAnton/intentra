import type { SseEvent } from '@intentra/contracts';

const BUFFER_LIMIT = 200;

export class EventBus {
  private readonly buffer: SseEvent[] = [];
  private readonly listeners = new Set<(event: SseEvent) => void>();
  private sequence = 0;

  publish(input: Omit<SseEvent, 'id' | 'at'>): SseEvent {
    this.sequence += 1;
    const event: SseEvent = {
      ...input,
      id: `${Date.now().toString(36)}-${this.sequence}`,
      at: new Date().toISOString(),
    };
    this.buffer.push(event);
    if (this.buffer.length > BUFFER_LIMIT) this.buffer.shift();
    for (const listener of this.listeners) listener(event);
    return event;
  }

  subscribe(listener: (event: SseEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  replay(lastEventId: string | undefined): SseEvent[] {
    if (!lastEventId) return [];
    const index = this.buffer.findIndex((event) => event.id === lastEventId);
    return index === -1 ? [] : this.buffer.slice(index + 1);
  }
}

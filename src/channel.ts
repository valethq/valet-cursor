/** Bridges a callback stream (Cursor's `onDelta`) to a pull loop that ends with one terminal value. */
export class EventQueue<T, R> {
  private items: T[] = [];
  private result?: { value: R };
  private wake?: () => void;

  push(...items: T[]): void {
    if (this.result || !items.length) return;
    this.items.push(...items);
    this.wake?.();
  }

  end(value: R): void {
    if (this.result) return;
    this.result = { value };
    this.wake?.();
  }

  async next(): Promise<{ item: T } | { done: R }> {
    for (;;) {
      const item = this.items.shift();
      if (item !== undefined) return { item };
      if (this.result) return { done: this.result.value };
      await new Promise<void>((r) => {
        this.wake = r;
      });
    }
  }
}

/** Invalidates asynchronous work when its owning chat view changes. */
export class ChatViewWorkRegistry {
  private generation = 0;
  private readonly controllers = new Set<AbortController>();

  /** Guard socket acknowledgements, which cannot be aborted like a fetch. */
  capture(): () => boolean {
    const generation = this.generation;
    return () => generation === this.generation;
  }

  begin() {
    const generation = this.generation;
    const controller = new AbortController();
    this.controllers.add(controller);
    return {
      signal: controller.signal,
      isCurrent: () => generation === this.generation && !controller.signal.aborted,
      finish: () => { this.controllers.delete(controller); },
    };
  }

  invalidate() {
    this.generation += 1;
    for (const controller of this.controllers) controller.abort();
    this.controllers.clear();
  }
}

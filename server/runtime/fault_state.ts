export type RuntimeFaultKind = 'uncaught_exception' | 'unhandled_rejection';
export interface RuntimeFaultSnapshot {
    degraded: boolean;
    acceptingWork: boolean;
    kind?: RuntimeFaultKind;
    occurredAt?: string;
}
/** A fatal fault is monotonic for this process. Only a fresh process can recover. */
export class RuntimeFaultState {
    private fault: RuntimeFaultSnapshot = { degraded: false, acceptingWork: true };
    private readonly listeners = new Set<() => void>();
    snapshot(): RuntimeFaultSnapshot { return { ...this.fault }; }
    record(kind: RuntimeFaultKind): void {
        if (this.fault.degraded)
            return;
        this.fault = { degraded: true, acceptingWork: false, kind, occurredAt: new Date().toISOString() };
        for (const listener of this.listeners) {
            try {
                listener();
            }
            catch (error) {
                console.error('[RuntimeFault] Failure stopping work:', error);
            }
        }
    }
    subscribe(listener: () => void): () => void {
        this.listeners.add(listener);
        if (this.fault.degraded)
            listener();
        return () => { this.listeners.delete(listener); };
    }
}
export const runtimeFaults = new RuntimeFaultState();

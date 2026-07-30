let activeExecutions = 0;
let lastAutomationAt = 0;

export function beginDesktopAutomationActivity(): void {
  activeExecutions += 1;
  lastAutomationAt = Date.now();
}

export function endDesktopAutomationActivity(): void {
  activeExecutions = Math.max(0, activeExecutions - 1);
  lastAutomationAt = Date.now();
}

export function wasDesktopAutomationRecentlyActive(graceMs = 8_000): boolean {
  return activeExecutions > 0 || (lastAutomationAt > 0 && Date.now() - lastAutomationAt <= graceMs);
}

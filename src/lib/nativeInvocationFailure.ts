/** A Rust preflight rejection explicitly proves this keyboard action never began. */
export function nativeInvocationFailure(command: string, error: unknown): Error {
  if (command === 'keyboard_press' && typeof error === 'string' && error.startsWith('[not_started] ')) {
    return new Error(error);
  }
  return new Error('[outcome_unknown] Native invocation did not return a terminal result: ' + String(error));
}

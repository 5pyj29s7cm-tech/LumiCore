/** Extend a turn's bindings without reading getters or copying mutable state. */
export function extendTurnBindings<Base extends object, Added extends object>(base: Base, added: Added): Base & Added {
  return Object.defineProperties(base, Object.getOwnPropertyDescriptors(added)) as Base & Added;
}

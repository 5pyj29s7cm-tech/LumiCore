const TOOL_LIFECYCLE_PERSISTENCE_FAILURE = Symbol.for(
  'lumi.tool_lifecycle_persistence_failure',
);

type BrandedLifecyclePersistenceFailure = Error & {
  [TOOL_LIFECYCLE_PERSISTENCE_FAILURE]?: true;
};

const brandedLifecycleFailures = new WeakSet<Error>();

/**
 * Brand only errors crossing a trusted lifecycle-callback boundary. Provider
 * handlers cannot opt themselves into this control-flow path by spoofing an
 * Error.name value.
 */
export function brandToolLifecyclePersistenceFailure(error: unknown): unknown {
  if (
    error instanceof Error
    && error.name === 'ToolLifecyclePersistenceError'
    && error.constructor?.name === 'ToolLifecyclePersistenceError'
  ) {
    brandedLifecycleFailures.add(error);
    if (Object.isExtensible(error)) {
      Object.defineProperty(error, TOOL_LIFECYCLE_PERSISTENCE_FAILURE, {
        value: true,
        enumerable: false,
        configurable: false,
        writable: false,
      });
    }
  }
  return error;
}

export function isToolLifecyclePersistenceFailure(
  error: unknown,
): error is BrandedLifecyclePersistenceFailure {
  return error instanceof Error
    && (
      brandedLifecycleFailures.has(error)
      || (error as BrandedLifecyclePersistenceFailure)[TOOL_LIFECYCLE_PERSISTENCE_FAILURE] === true
    );
}

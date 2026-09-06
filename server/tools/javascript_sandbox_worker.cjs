// Only this trusted wrapper runs in Node. User code runs in the separate
// QuickJS WebAssembly heap with no module loader or host/system APIs.
const { parentPort, workerData } = require('node:worker_threads');
const { newQuickJSWASMModuleFromVariant } = require('quickjs-emscripten-core');
const variant = require('@jitl/quickjs-singlefile-cjs-release-sync').default;

async function execute() {
  const module = await newQuickJSWASMModuleFromVariant(variant);
  const runtime = module.newRuntime();
  runtime.setMemoryLimit(16 * 1024 * 1024);
  runtime.setMaxStackSize(256 * 1024);
  runtime.setInterruptHandler(() => Date.now() >= workerData.deadline);
  const context = runtime.newContext();
  const output = [];
  let outputBytes = 0;
  let resultHandle;
  let settledHandle;
  let serializeHandle;
  const append = (prefix, args) => {
    const text = prefix + args.map(handle => {
      const value = context.dump(handle);
      return typeof value === 'string' ? value : JSON.stringify(value) ?? String(value);
    }).join(' ');
    if (Date.now() >= workerData.deadline) throw new Error('Execution timed out.');
    outputBytes += Buffer.byteLength(text, 'utf8') + 1;
    if (outputBytes > workerData.maxOutputBytes) throw new Error('Output limit exceeded.');
    output.push(text);
  };
  try {
    // Keep serialization in the guest with an explicit error result. dump()
    // alone can fall back to a string when a getter/JSON conversion is interrupted.
    serializeHandle = context.unwrapResult(context.evalCode('(stringify => value => stringify(value))(JSON.stringify)'));
    const consoleObject = context.newObject();
    try {
      for (const name of ['log', 'info', 'warn', 'error']) {
        const fn = context.newFunction(name, (...args) => {
          try { append(name === 'warn' || name === 'error' ? `[${name}] ` : '', args); }
          catch { return { error: context.newError('Console output could not be serialized within the output limit.') }; }
        });
        try { context.setProp(consoleObject, name, fn); } finally { fn.dispose(); }
      }
      context.setProp(context.global, 'console', consoleObject);
    } finally { consoleObject.dispose(); }

    const evaluated = context.evalCode(workerData.code, 'calculation.js', { type: 'global' });
    if (evaluated.error) {
      try { throw new Error(context.dump(evaluated.error)?.message || 'JavaScript execution failed.'); }
      finally { evaluated.error.dispose(); }
    }
    resultHandle = evaluated.value;
    // Drain guest promises under the same CPU/memory deadline. No host promises,
    // timers, fetch or other asynchronous host capabilities are installed.
    while (runtime.hasPendingJob()) {
      const jobs = runtime.executePendingJobs(32);
      if (jobs.error) {
        try { throw new Error(context.dump(jobs.error)?.message || 'JavaScript promise failed.'); }
        finally { jobs.error.dispose(); }
      }
      if (Date.now() >= workerData.deadline) throw new Error('Execution timed out.');
    }
    const state = context.getPromiseState(resultHandle);
    if (state.type === 'pending') throw new Error('Promise did not settle; host timers and I/O are unavailable.');
    if (state.type === 'rejected') {
      try { throw new Error(context.dump(state.error)?.message || String(context.dump(state.error))); }
      finally { state.error.dispose(); }
    }
    settledHandle = state.value;
    let value = output.length ? output.join('\n') : null;
    if (!output.length) {
      const serialized = context.callFunction(serializeHandle, context.undefined, settledHandle);
      if (serialized.error) {
        try { throw new Error(context.dump(serialized.error)?.message || 'Result serialization failed.'); }
        finally { serialized.error.dispose(); }
      }
      try {
        if (context.typeof(serialized.value) !== 'undefined') value = JSON.parse(context.getString(serialized.value));
      } finally { serialized.value.dispose(); }
    }
    const encoded = JSON.stringify({ ok: true, status: 'completed', output: value });
    if (Date.now() >= workerData.deadline) throw new Error('Execution timed out.');
    if (Buffer.byteLength(encoded, 'utf8') > workerData.maxOutputBytes) throw new Error('Output limit exceeded.');
    return encoded;
  } catch (error) {
    return JSON.stringify({ ok: false, status: 'failed', output: output.join('\n'),
      error: Date.now() >= workerData.deadline ? 'Execution timed out.' : String(error?.message || 'JavaScript execution failed.').slice(0, 1000) });
  } finally {
    // For a non-promise getPromiseState borrows the original result handle.
    if (settledHandle && settledHandle !== resultHandle) settledHandle.dispose();
    resultHandle?.dispose();
    serializeHandle?.dispose();
    context.dispose();
    runtime.dispose();
  }
}

execute().then(result => parentPort.postMessage(result), () => {
  parentPort.postMessage(JSON.stringify({ ok: false, status: 'failed', output: '', error: 'JavaScript runtime failed.' }));
}).finally(() => parentPort.close());

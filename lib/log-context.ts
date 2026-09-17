/**
 * Fields attached to every log line written while a request or job is being handled.
 * `requestId` is the API request; `correlationId` is the request that caused a job, so a
 * request's lines and its jobs' lines can be found with one search.
 *
 * This file is imported (through lib/log and lib/errors) by modules that also reach client bundles, so it
 * must not import Node built-ins. The AsyncLocalStorage behind it is installed by lib/log-context-node.ts,
 * from instrumentation.ts in the app and from the worker entrypoint. Without it, context is simply empty.
 */
export type LogContext = {
  requestId?: string;
  correlationId?: string;
  jobId?: string;
  queue?: string;
  jobName?: string;
};

export type ContextStorage = {
  getStore(): LogContext | undefined;
  run<T>(store: LogContext, fn: () => T): T;
};

const slot = globalThis as unknown as { saakuuLogContext?: ContextStorage; saakuuIncomingRequestId?: () => Promise<string | null> };

export function installLogContextStorage(storage: ContextStorage): void {
  slot.saakuuLogContext ??= storage;
}

/** Installed by instrumentation.ts: reads the `x-request-id` header middleware set, inside a request. */
export function installRequestIdSource(source: () => Promise<string | null>): void {
  slot.saakuuIncomingRequestId ??= source;
}

/** The current request's id from middleware, or a new one (scripts, worker, or no request scope). */
export async function resolveRequestId(): Promise<string> {
  try {
    const incoming = await slot.saakuuIncomingRequestId?.();
    if (isValidRequestId(incoming)) return incoming;
  } catch {
    // not inside a request scope
  }
  return crypto.randomUUID();
}

export function withLogContext<T>(context: LogContext, fn: () => T): T {
  const storage = slot.saakuuLogContext;
  return storage ? storage.run({ ...storage.getStore(), ...context }, fn) : fn();
}

export function currentLogContext(): LogContext {
  return slot.saakuuLogContext?.getStore() ?? {};
}

/** The id a job enqueued now should carry: the current request, or the job that enqueued it. */
export function currentCorrelationId(): string | undefined {
  const context = currentLogContext();
  return context.correlationId ?? context.requestId;
}

const REQUEST_ID = /^[\w-]{8,64}$/;

/** Accepts a well-formed incoming id (e.g. from a proxy); anything else is replaced. */
export function isValidRequestId(value: string | null | undefined): value is string {
  return typeof value === "string" && REQUEST_ID.test(value);
}

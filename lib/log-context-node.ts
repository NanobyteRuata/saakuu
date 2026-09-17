import { AsyncLocalStorage } from "node:async_hooks";

import { installLogContextStorage, type LogContext } from "./log-context";

/** Server-only: gives lib/log-context its storage. Imported for its side effect. */
installLogContextStorage(new AsyncLocalStorage<LogContext>());

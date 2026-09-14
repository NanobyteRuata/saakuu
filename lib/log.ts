type Level = "debug" | "info" | "warn" | "error";
type Fields = Record<string, unknown>;

function serialiseError(err: unknown): Fields {
  if (err instanceof Error) {
    return { errorName: err.name, errorMessage: err.message, stack: err.stack };
  }
  return { error: String(err) };
}

function write(level: Level, msg: string, fields?: Fields): void {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, msg, ...fields });
  if (level === "error" || level === "warn") {
    console.error(line);
  } else {
    console.log(line);
  }
}

/** Structured JSON-lines logger. Stack traces go here, never to the user. */
export const log = {
  debug: (msg: string, fields?: Fields) => write("debug", msg, fields),
  info: (msg: string, fields?: Fields) => write("info", msg, fields),
  warn: (msg: string, fields?: Fields) => write("warn", msg, fields),
  error: (msg: string, err?: unknown, fields?: Fields) =>
    write("error", msg, { ...fields, ...(err === undefined ? {} : serialiseError(err)) }),
};

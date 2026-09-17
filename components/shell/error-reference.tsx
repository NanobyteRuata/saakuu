/** The server's error digest, so a report can be matched to the log line that has the stack trace. */
export function ErrorReference({ digest }: { digest?: string }) {
  if (!digest) return null;
  return (
    <p className="text-muted-foreground text-xs">
      Reference: <span className="font-mono">{digest}</span>
    </p>
  );
}

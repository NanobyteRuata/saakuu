import { NAME_SEPARATOR } from "@/lib/templates/field-list";
import { cn } from "@/lib/utils";

/**
 * A field's name wherever names are listed (decision 84). The end of a name is the field's own
 * words, so it is never cut off: the name wraps, or, where it must stay on one line, the headers in
 * front are shortened instead (`RDT Test › Pos… › A`).
 */
export function FieldName({ name, lang, oneLine = false, className }: { name: string; lang?: string | undefined; oneLine?: boolean; className?: string }) {
  const at = name.lastIndexOf(NAME_SEPARATOR);
  const headers = at < 0 ? "" : name.slice(0, at);
  const own = at < 0 ? name : name.slice(at);
  if (oneLine && headers !== "") {
    return (
      <span lang={lang} title={name} className={cn("font-value flex min-w-0 items-baseline", className)}>
        <span className="text-muted-foreground min-w-0 truncate">{headers}</span>
        <span className="shrink-0 whitespace-pre">{own}</span>
      </span>
    );
  }
  return (
    <span lang={lang} className={cn("font-value break-words", className)}>
      {headers !== "" ? <span className="text-muted-foreground">{headers}</span> : null}
      {own}
    </span>
  );
}

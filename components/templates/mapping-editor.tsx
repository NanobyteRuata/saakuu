"use client";

import { useCallback, useMemo, useState } from "react";
import { toast } from "sonner";

import { getJson } from "@/lib/api-client";
import { langOf } from "@/lib/templates/labels";
import type { TemplateDetail } from "@/lib/templates/service";
import { buildTree } from "@/lib/templates/tree";

import { MappingTab } from "./mapping-tab";
import { TemplateChrome } from "./template-chrome";

/** The Mapping route: fields on one side of the template, the columns they fill on the other. */
export function MappingEditor({ initial, bookDefaultModel }: { initial: TemplateDetail; bookDefaultModel: string }) {
  const [template, setTemplate] = useState(initial);
  const lang = langOf(template.languageHint);
  const tree = useMemo(() => buildTree(template.groups, template.fields), [template.groups, template.fields]);

  const reload = useCallback(async () => {
    const result = await getJson<TemplateDetail>(`/api/templates/${template.id}`);
    if (result.ok) setTemplate(result.data);
    else toast.error(result.error.message);
  }, [template.id]);

  return (
    <TemplateChrome template={template} bookDefaultModel={bookDefaultModel} active="mapping" onTemplate={setTemplate}>
      <MappingTab template={template} tree={tree} lang={lang} onChanged={reload} />
    </TemplateChrome>
  );
}

"use client";

import { useCallback, useMemo, useState } from "react";
import { toast } from "sonner";

import { getJson } from "@/lib/api-client";
import { langOf } from "@/lib/templates/labels";
import type { TemplateDetail } from "@/lib/templates/service";
import { orderFields } from "@/lib/templates/field-list";

import { MappingTab } from "./mapping-tab";
import { TemplateChrome } from "./template-chrome";

/** The Mapping route: fields on one side of the template, the columns they fill on the other. */
export function MappingEditor({ initial, bookDefaultModel }: { initial: TemplateDetail; bookDefaultModel: string }) {
  const [template, setTemplate] = useState(initial);
  const lang = langOf(template.languageHint);
  const fields = useMemo(() => orderFields(template.fields).list, [template.fields]);

  const reload = useCallback(async () => {
    const result = await getJson<TemplateDetail>(`/api/templates/${template.id}`);
    if (result.ok) setTemplate(result.data);
    else toast.error(result.error.message);
  }, [template.id]);

  return (
    <TemplateChrome template={template} bookDefaultModel={bookDefaultModel} active="mapping" onTemplate={setTemplate} scroll>
      <MappingTab template={template} fields={fields} lang={lang} onChanged={reload} />
    </TemplateChrome>
  );
}

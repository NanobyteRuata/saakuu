"use client";

import { Toaster as Sonner, type ToasterProps } from "sonner";

/** Success toasts. Validation errors stay inline; degraded states use banners (docs/05 → Global). */
function Toaster(props: ToasterProps) {
  return <Sonner position="bottom-right" closeButton {...props} />;
}

export { Toaster };

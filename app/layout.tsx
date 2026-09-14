import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

import { Toaster } from "@/components/ui/sonner";

export const metadata: Metadata = {
  title: "SaaKuu",
  description: "Assisted data entry for handwritten forms and tables.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        {children}
        <Toaster />
      </body>
    </html>
  );
}

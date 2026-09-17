"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { getJson } from "@/lib/api-client";
import type { TableDocument, TableMeta, TableRow } from "@/lib/table/types";
import { decodePage, type WirePage } from "@/lib/table/wire";

/**
 * Every row of a book in manual order, loaded page by page in the background after the first page the server
 * rendered. The output table and row review both hold the whole book, so counts and navigation cover all of it.
 */
export function useBookRows(initialMeta: TableMeta, firstPage: WirePage) {
  const [meta, setMeta] = useState(initialMeta);
  const [rows, setRows] = useState<TableRow[]>(() => decodePage(firstPage).items);
  const [documents, setDocuments] = useState<Map<string, TableDocument>>(() => new Map(firstPage.documents.map((d) => [d.id, d])));
  const [nextCursor, setNextCursor] = useState(firstPage.nextCursor);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const rowsRef = useRef(rows);
  rowsRef.current = rows;

  useEffect(() => {
    if (!nextCursor) return;
    let cancelled = false;
    void getJson<WirePage>(`/api/books/${meta.bookId}/rows?cursor=${encodeURIComponent(nextCursor)}`).then((result) => {
      if (cancelled) return;
      if (!result.ok) {
        setLoadError(result.error.message);
        return;
      }
      const page = decodePage(result.data);
      setRows((prev) => {
        const seen = new Set(prev.map((r) => r.id));
        return [...prev, ...page.items.filter((r) => !seen.has(r.id))];
      });
      setDocuments((prev) => new Map([...prev, ...page.documents.map((d) => [d.id, d] as const)]));
      setNextCursor(page.nextCursor);
    });
    return () => {
      cancelled = true;
    };
  }, [nextCursor, meta.bookId]);

  /** Reloads from the first page. Resolves true when the rows were replaced. */
  const refresh = useCallback(async (): Promise<boolean> => {
    setRefreshing(true);
    setLoadError(null);
    const [m, p] = await Promise.all([getJson<TableMeta>(`/api/books/${meta.bookId}/table-meta`), getJson<WirePage>(`/api/books/${meta.bookId}/rows`)]);
    setRefreshing(false);
    if (!m.ok || !p.ok) {
      setLoadError((!m.ok ? m.error.message : !p.ok ? p.error.message : null) ?? "The table couldn't be loaded.");
      return false;
    }
    const page = decodePage(p.data);
    setMeta(m.data);
    setRows(page.items);
    setDocuments(new Map(page.documents.map((d) => [d.id, d])));
    setNextCursor(page.nextCursor);
    return true;
  }, [meta.bookId]);

  return { meta, setMeta, rows, setRows, rowsRef, documents, nextCursor, loadError, refreshing, refresh };
}

import { describe, expect, it } from "vitest";

import { classifyObject, SWEEP_MIN_AGE_MS, type ObjectRefs } from "./lifecycle";

const now = new Date("2026-09-17T00:00:00Z");
const old = new Date(now.getTime() - SWEEP_MIN_AGE_MS - 1);
const fresh = new Date(now.getTime() - 1000);

function refs(partial: Partial<ObjectRefs> = {}): ObjectRefs {
  return {
    referencedKeys: new Set(),
    livePhotoIds: new Set(),
    tombstonedPhotoIds: new Set(),
    tombstonedKeys: new Set(),
    uploadsWithPages: new Set(),
    ...partial,
  };
}

const upload = "books/b1/uploads/u1/original.jpg";
const pdf = "books/b1/uploads/u2/original.pdf";
const page = "books/b1/pages/u2/page-001.png";
const base = "books/b1/photos/p1/base.jpg";
const working = "books/b1/photos/p1/working-aaaaaaaaaaaa.jpg";
const oldWorking = "books/b1/photos/p1/working-bbbbbbbbbbbb.jpg";

describe("classifyObject: storage is only deleted when nothing refers to it", () => {
  it("keeps every key a photo row references, however old", () => {
    const r = refs({ referencedKeys: new Set([upload, page, working]), livePhotoIds: new Set(["p1"]) });
    for (const key of [upload, page, working]) expect(classifyObject(key, old, now, r)).toBe("keep");
  });

  it("keeps a shared key referenced by another photo's row", () => {
    const shared = "books/b1/photos/seed/working-seed.jpg";
    expect(classifyObject(shared, old, now, refs({ referencedKeys: new Set([shared]) }))).toBe("keep");
  });

  it("keeps a live photo's base copy", () => {
    expect(classifyObject(base, old, now, refs({ livePhotoIds: new Set(["p1"]) }))).toBe("keep");
  });

  it("keeps a PDF while any of its pages is a photo", () => {
    expect(classifyObject(pdf, old, now, refs({ uploadsWithPages: new Set(["u2"]) }))).toBe("keep");
  });

  it("keeps tombstoned files for the tombstone to delete after the grace period", () => {
    const r = refs({ tombstonedPhotoIds: new Set(["p1"]), tombstonedKeys: new Set([upload]) });
    expect(classifyObject(base, old, now, r)).toBe("keep");
    expect(classifyObject(working, old, now, r)).toBe("keep");
    expect(classifyObject(upload, old, now, r)).toBe("keep");
  });

  it("keeps anything younger than a day: an upload or render may be in flight", () => {
    expect(classifyObject(upload, fresh, now, refs())).toBe("keep");
    expect(classifyObject(oldWorking, fresh, now, refs({ livePhotoIds: new Set(["p1"]) }))).toBe("keep");
  });

  it("keeps keys it doesn't recognise", () => {
    expect(classifyObject("books/b1/exports/x.csv", old, now, refs())).toBe("keep");
    expect(classifyObject("other/thing.jpg", old, now, refs())).toBe("keep");
  });

  it("deletes abandoned uploads, orphaned pages, files of vanished photos and superseded renders", () => {
    expect(classifyObject(upload, old, now, refs())).toBe("delete");
    expect(classifyObject(pdf, old, now, refs())).toBe("delete");
    expect(classifyObject(page, old, now, refs())).toBe("delete");
    expect(classifyObject(base, old, now, refs())).toBe("delete");
    const live = refs({ livePhotoIds: new Set(["p1"]), referencedKeys: new Set([working]) });
    expect(classifyObject(oldWorking, old, now, live)).toBe("delete");
    expect(classifyObject(working, old, now, live)).toBe("keep");
  });
});

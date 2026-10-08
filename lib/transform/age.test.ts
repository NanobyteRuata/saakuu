import { describe, expect, it } from "vitest";

import { parseAge } from "./normalise";

/** An age's unit decides what number lands in the cell, so a wrong conversion is silent bad data. */
describe("parseAge", () => {
  it("reads numbers as years and gives them in the field's unit", () => {
    expect(parseAge("1 1/2", "YEARS")).toEqual({ text: "1.5", rounded: false });
    expect(parseAge("1 1/2", "MONTHS")).toEqual({ text: "18", rounded: false });
    expect(parseAge("1 1/2", "YEARS_MONTHS")).toEqual({ text: "1y 6m", rounded: false });
    expect(parseAge("2", "YEARS")).toEqual({ text: "2", rounded: false });
    expect(parseAge("၂", "YEARS_MONTHS")).toEqual({ text: "2y 0m", rounded: false });
  });

  it("rounds years that aren't exact and says so", () => {
    expect(parseAge("4/12", "YEARS")).toEqual({ text: "0.33", rounded: true });
    expect(parseAge("4/12", "MONTHS")).toEqual({ text: "4", rounded: false });
    expect(parseAge("4/12", "YEARS_MONTHS")).toEqual({ text: "0y 4m", rounded: false });
    // A seventh of a year has no exact months either: years still round, months refuse.
    expect(parseAge("1/7", "YEARS")).toEqual({ text: "0.14", rounded: true });
    expect(parseAge("1/7", "MONTHS")).toBeNull();
    expect(parseAge("1/7", "YEARS_MONTHS")).toBeNull();
  });

  it("reads written units", () => {
    expect(parseAge("1y 6m", "YEARS")).toEqual({ text: "1.5", rounded: false });
    expect(parseAge("1 နှစ် 6 လ", "MONTHS")).toEqual({ text: "18", rounded: false });
    expect(parseAge("30 m", "YEARS_MONTHS")).toEqual({ text: "2y 6m", rounded: false });
  });

  it("refuses what it can't read", () => {
    expect(parseAge("old", "YEARS")).toBeNull();
    expect(parseAge("1/0", "MONTHS")).toBeNull();
  });
});

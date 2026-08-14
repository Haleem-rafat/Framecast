import { describe, expect, it } from "vitest";

import { filterRows, sortRows } from "@/components/shared/data-table";

/**
 * Covers the two pure functions behind `DataTable` rather than the rendered
 * table: the repo's Vitest environment is `node`, so there is no DOM to render
 * into, and in any case the decisions worth protecting from a future edit all
 * live here — where blanks end up, whether ties stay put, and what a
 * multi-word search means.
 */

interface Row {
  title: string;
  project: string | null;
  count: number;
}

const rows: Row[] = [
  { title: "Episode 10", project: "Alpha", count: 3 },
  { title: "episode 2", project: null, count: 12 },
  { title: "Ambient loops", project: "beta", count: 3 },
];

describe("filterRows", () => {
  const accessors = [(row: Row) => row.title, (row: Row) => row.project ?? ""];

  it("returns the rows untouched when the query is blank", () => {
    expect(filterRows(rows, "   ", accessors)).toBe(rows);
  });

  it("matches case-insensitively across every filterable column", () => {
    expect(filterRows(rows, "ALPHA", accessors)).toEqual([rows[0]]);
  });

  it("requires every term to match, not the query as one substring", () => {
    // "episode alpha" spans two columns and is not a contiguous substring of
    // either — the AND-across-terms behaviour is the whole point.
    expect(filterRows(rows, "episode alpha", accessors)).toEqual([rows[0]]);
    expect(filterRows(rows, "episode gamma", accessors)).toEqual([]);
  });

  it("filters nothing when no column opted in", () => {
    expect(filterRows(rows, "alpha", [])).toBe(rows);
  });
});

describe("sortRows", () => {
  it("orders numeric runs inside strings by value, not by digit", () => {
    const sorted = sortRows(rows, (row) => row.title, "asc");

    expect(sorted.map((row) => row.title)).toEqual([
      "Ambient loops",
      "episode 2",
      "Episode 10",
    ]);
  });

  it("keeps blanks at the bottom in both directions", () => {
    const asc = sortRows(rows, (row) => row.project, "asc");
    const desc = sortRows(rows, (row) => row.project, "desc");

    expect(asc.map((row) => row.project)).toEqual(["Alpha", "beta", null]);
    expect(desc.map((row) => row.project)).toEqual(["beta", "Alpha", null]);
  });

  it("treats an empty string as blank", () => {
    const withEmpty: Row[] = [
      { title: "b", project: "", count: 0 },
      { title: "a", project: "z", count: 0 },
    ];

    expect(
      sortRows(withEmpty, (row) => row.project, "asc").map((row) => row.title),
    ).toEqual(["a", "b"]);
  });

  it("leaves tied rows in the order they arrived", () => {
    const sorted = sortRows(rows, (row) => row.count, "asc");

    expect(sorted.map((row) => row.title)).toEqual([
      "Episode 10",
      "Ambient loops",
      "episode 2",
    ]);
  });

  it("orders dates chronologically rather than as strings", () => {
    const dated = [
      { at: new Date("2026-02-01T00:00:00Z") },
      { at: new Date("2026-01-09T00:00:00Z") },
    ];

    expect(
      sortRows(dated, (row) => row.at, "desc").map((row) => row.at.getUTCMonth()),
    ).toEqual([1, 0]);
  });

  it("does not mutate the array it was given", () => {
    const original = [...rows];
    sortRows(rows, (row) => row.title, "desc");

    expect(rows).toEqual(original);
  });
});

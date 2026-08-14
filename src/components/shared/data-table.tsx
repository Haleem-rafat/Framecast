"use client";

import { useMemo, useState, type ReactNode } from "react";
import { ArrowDown, ArrowUp, ChevronsUpDown, Columns3 } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";

export type SortDirection = "asc" | "desc";

/** What a column can sort by. `Date` and `boolean` are normalised internally. */
export type SortValue = string | number | boolean | Date | null | undefined;

export interface DataTableColumn<Row> {
  id: string;
  /**
   * Plain text rather than a node: this one string is the `<th>` copy, the
   * sort button's accessible name, and the column-toggle label, and keeping
   * them in sync by construction is worth more than the freedom to put
   * markup in a header none of our tables needs.
   */
  header: string;
  cell: (row: Row) => ReactNode;
  /** Omit to make the column unsortable — no button, no `aria-sort`. */
  sortValue?: (row: Row) => SortValue;
  /** Text this column contributes to the search box. Omit to exclude it. */
  filterValue?: (row: Row) => string;
  align?: "left" | "right";
  /** Which way the *first* click sorts. Recency and counts read best newest/largest first. */
  firstSortDirection?: SortDirection;
  headClassName?: string;
  cellClassName?: string;
  /** Keeps the column out of the visibility menu — for identity and action columns. */
  alwaysVisible?: boolean;
}

interface DataTableProps<Row> {
  rows: Row[];
  columns: DataTableColumn<Row>[];
  getRowId: (row: Row) => string;
  /**
   * Accessible name for the table, rendered as a visually hidden `<caption>`.
   * Required rather than optional so a new table cannot ship nameless.
   */
  caption: string;
  /**
   * Rendered *instead of* the whole table when there is no data at all — the
   * page's own `EmptyState` card, normally. Deliberately distinct from the
   * "your search matched nothing" row below, which keeps the table and its
   * toolbar on screen so the operator can see and undo what they typed.
   */
  empty?: ReactNode;
  /** Omit for no pagination — right for short, fixed row sets. */
  pageSize?: number;
  /** Shown only when at least one column defines `filterValue`. */
  searchPlaceholder?: string;
  columnToggle?: boolean;
}

/**
 * Client-side sorting, searching and pagination over rows a server component
 * has already fetched in full. Every table in the app is small enough that
 * round-tripping to the server to re-sort would be slower and more code than
 * doing it here, so none of the state below is reflected in the URL — the one
 * filter that *is* a server concern (video status) stays a route param owned
 * by the page.
 *
 * Note that consumers of this component must be client components themselves:
 * `cell` and `sortValue` are functions, and functions do not cross the RSC
 * boundary. That is a real cost for the two provider tables, which are static
 * and would otherwise ship no JS; it is paid for by every table sharing one
 * set of accessibility guarantees (`<th scope>`, `aria-sort`, a caption)
 * instead of four hand-rolled approximations of them.
 */
export function DataTable<Row>({
  rows,
  columns,
  getRowId,
  caption,
  empty,
  pageSize,
  searchPlaceholder,
  columnToggle = false,
}: DataTableProps<Row>) {
  // Starts unsorted on purpose: every caller's rows arrive in an order the
  // server chose deliberately, and that order is worth showing on load.
  const [sort, setSort] = useState<
    { columnId: string; direction: SortDirection } | null
  >(null);
  const [query, setQuery] = useState("");
  const [pageIndex, setPageIndex] = useState(0);
  const [hiddenColumnIds, setHiddenColumnIds] = useState<string[]>([]);

  const visibleColumns = useMemo(
    () => columns.filter((column) => !hiddenColumnIds.includes(column.id)),
    [columns, hiddenColumnIds],
  );

  const filterAccessors = useMemo(
    () =>
      columns.flatMap((column) => (column.filterValue ? [column.filterValue] : [])),
    [columns],
  );
  const toggleableColumns = columns.filter((column) => !column.alwaysVisible);

  const filteredRows = useMemo(
    () => filterRows(rows, query, filterAccessors),
    [filterAccessors, query, rows],
  );

  const sortedRows = useMemo(() => {
    if (!sort) return filteredRows;

    const column = columns.find((one) => one.id === sort.columnId);
    if (!column?.sortValue) return filteredRows;

    return sortRows(filteredRows, column.sortValue, sort.direction);
  }, [columns, filteredRows, sort]);

  const pageCount = pageSize ? Math.max(1, Math.ceil(sortedRows.length / pageSize)) : 1;
  // Clamped rather than reset in an effect: sorting, searching or a change to
  // `rows` from the server can all shrink the row set out from under the
  // current page, and deriving the safe page keeps that a one-pass render.
  const safePageIndex = Math.min(pageIndex, pageCount - 1);
  const pageRows = pageSize
    ? sortedRows.slice(safePageIndex * pageSize, safePageIndex * pageSize + pageSize)
    : sortedRows;

  if (rows.length === 0 && empty) {
    return <>{empty}</>;
  }

  function onSort(column: DataTableColumn<Row>) {
    setPageIndex(0);
    setSort((current) => {
      if (current?.columnId !== column.id) {
        return {
          columnId: column.id,
          direction: column.firstSortDirection ?? "asc",
        };
      }
      // Third click clears the sort rather than cycling back to the first
      // direction, so the server's own ordering stays reachable.
      const next = current.direction === "asc" ? "desc" : "asc";
      return next === (column.firstSortDirection ?? "asc")
        ? null
        : { columnId: column.id, direction: next };
    });
  }

  function onToggleColumn(columnId: string, shown: boolean) {
    setHiddenColumnIds((current) =>
      shown ? current.filter((id) => id !== columnId) : [...current, columnId],
    );
    // A sort applied to a column the operator has just hidden reorders the
    // table by something no longer on screen, which reads as a glitch.
    if (!shown) {
      setSort((current) => (current?.columnId === columnId ? null : current));
    }
  }

  const showSearch = Boolean(searchPlaceholder) && filterAccessors.length > 0;
  const showColumnToggle = columnToggle && toggleableColumns.length > 0;

  return (
    <div className="space-y-3">
      {(showSearch || showColumnToggle) && (
        <div className="flex flex-wrap items-center gap-2">
          {showSearch && (
            <Input
              type="search"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setPageIndex(0);
              }}
              placeholder={searchPlaceholder}
              aria-label={searchPlaceholder}
              className="max-w-xs"
            />
          )}
          {showColumnToggle && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm" className="ml-auto">
                  <Columns3 />
                  Columns
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuLabel>Visible columns</DropdownMenuLabel>
                <DropdownMenuSeparator />
                {toggleableColumns.map((column) => {
                  const shown = !hiddenColumnIds.includes(column.id);

                  return (
                    <DropdownMenuCheckboxItem
                      key={column.id}
                      checked={shown}
                      // Hiding the last visible column would leave an empty
                      // table with no way back — better to grey the control
                      // out than to accept the click and render nothing.
                      disabled={shown && visibleColumns.length === 1}
                      onCheckedChange={(checked) => onToggleColumn(column.id, checked)}
                    >
                      {column.header}
                    </DropdownMenuCheckboxItem>
                  );
                })}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      )}

      <Table>
        <TableCaption className="sr-only">{caption}</TableCaption>
        <TableHeader>
          <TableRow>
            {visibleColumns.map((column) => {
              const sorted = sort?.columnId === column.id ? sort.direction : null;

              return (
                <TableHead
                  key={column.id}
                  scope="col"
                  aria-sort={
                    column.sortValue
                      ? sorted === "asc"
                        ? "ascending"
                        : sorted === "desc"
                          ? "descending"
                          : "none"
                      : undefined
                  }
                  className={cn(
                    column.align === "right" && "text-right",
                    column.headClassName,
                  )}
                >
                  {column.sortValue ? (
                    <button
                      type="button"
                      onClick={() => onSort(column)}
                      className="group/sort focus-visible:ring-ring/50 -mx-1 inline-flex h-7 items-center gap-1 rounded-md px-1 font-medium outline-none focus-visible:ring-3"
                    >
                      {column.header}
                      {sorted === "asc" ? (
                        <ArrowUp className="size-3.5" />
                      ) : sorted === "desc" ? (
                        <ArrowDown className="size-3.5" />
                      ) : (
                        <ChevronsUpDown className="size-3.5 opacity-0 transition-opacity group-hover/sort:opacity-60 group-focus-visible/sort:opacity-60" />
                      )}
                    </button>
                  ) : (
                    column.header
                  )}
                </TableHead>
              );
            })}
          </TableRow>
        </TableHeader>
        <TableBody>
          {pageRows.length === 0 ? (
            <TableRow>
              <TableCell
                colSpan={visibleColumns.length}
                className="text-muted-foreground h-24 text-center"
              >
                {query ? (
                  <>
                    No rows match <span className="text-foreground font-medium">{query}</span>
                  </>
                ) : (
                  "Nothing to show"
                )}
              </TableCell>
            </TableRow>
          ) : (
            pageRows.map((row) => (
              <TableRow key={getRowId(row)}>
                {visibleColumns.map((column) => (
                  <TableCell
                    key={column.id}
                    className={cn(
                      column.align === "right" && "text-right",
                      column.cellClassName,
                    )}
                  >
                    {column.cell(row)}
                  </TableCell>
                ))}
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>

      {pageSize !== undefined && sortedRows.length > pageSize && (
        <div className="flex flex-wrap items-center justify-between gap-2">
          {/* Announced on page change: the buttons keep focus, so without this
              a screen-reader user gets no confirmation the rows moved. */}
          <p className="text-muted-foreground text-sm" aria-live="polite">
            {safePageIndex * pageSize + 1}–
            {Math.min((safePageIndex + 1) * pageSize, sortedRows.length)} of{" "}
            {sortedRows.length}
          </p>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPageIndex(safePageIndex - 1)}
              disabled={safePageIndex === 0}
            >
              Previous
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPageIndex(safePageIndex + 1)}
              disabled={safePageIndex >= pageCount - 1}
            >
              Next
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Keeps rows where every whitespace-separated term matches somewhere, rather
 * than treating the query as one substring: it lets "draft ai" narrow by
 * status and title at once, which is how the video list actually gets used.
 *
 * Exported alongside `sortRows` because these two encode the behaviour worth
 * pinning down in tests — the component around them is assembly.
 */
export function filterRows<Row>(
  rows: Row[],
  query: string,
  accessors: ((row: Row) => string)[],
): Row[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0 || accessors.length === 0) return rows;

  return rows.filter((row) => {
    const haystack = accessors
      .map((accessor) => accessor(row))
      .join(" ")
      .toLowerCase();

    return terms.every((term) => haystack.includes(term));
  });
}

export function sortRows<Row>(
  rows: Row[],
  sortValue: (row: Row) => SortValue,
  direction: SortDirection,
): Row[] {
  const sign = direction === "asc" ? 1 : -1;

  // Keys are read once per row rather than once per comparison — `sortValue`
  // is consumer code and may do real work (label lookups, index scans).
  // Rows with nothing in the sorted column then sink to the bottom in *both*
  // directions: letting them flip to the top on the second click buries the
  // rows the operator was reading behind a block of blanks.
  const present: { row: Row; key: string | number }[] = [];
  const missing: Row[] = [];
  for (const row of rows) {
    const key = toComparable(sortValue(row));
    if (key === null) missing.push(row);
    else present.push({ row, key });
  }

  // `sort` is stable, so rows that tie keep the order the server sent them in.
  present.sort((a, b) => sign * compare(a.key, b.key));

  return [...present.map((entry) => entry.row), ...missing];
}

/**
 * Collapses the sortable value types down to the two things we can actually
 * order. Empty strings join `null`/`undefined` as "missing": a blank cell and
 * an absent one look identical in the table, so they should sort identically.
 */
function toComparable(value: SortValue): string | number | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.getTime();
  if (typeof value === "boolean") return Number(value);
  if (typeof value === "string" && value.trim() === "") return null;
  return value;
}

function compare(a: string | number, b: string | number): number {
  if (typeof a === "number" && typeof b === "number") return a - b;

  // `numeric` so "Episode 2" precedes "Episode 10", `base` so casing doesn't
  // split otherwise-identical titles apart.
  return String(a).localeCompare(String(b), undefined, {
    numeric: true,
    sensitivity: "base",
  });
}

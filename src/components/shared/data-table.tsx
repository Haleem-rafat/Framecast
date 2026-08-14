"use client";

import { Fragment, useMemo, useState, type ReactNode } from "react";
import { ArrowDown, ArrowUp, ArrowUpDown, ChevronsUpDown, Columns3 } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
   * sort button's accessible name, the column-toggle label, the `<dt>` label
   * on the card layout and the small-screen sort picker's entry, and keeping
   * them in sync by construction is worth more than the freedom to put
   * markup in a header none of our tables needs. It should therefore read as
   * a label for a single value — "Last tested", not "Key status".
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
 * Radix's `Select` treats the empty string as "no value chosen" and throws if
 * an item claims it, so the "leave the rows in the server's order" entry needs
 * a value of its own. A sentinel string rather than rendering that entry
 * conditionally: the operator needs a way *back* to the unsorted order on
 * small screens, where there is no header to click a third time.
 */
const UNSORTED_VALUE = "__unsorted__";

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

  // The card layout reads the same `visibleColumns`, so hiding a column from
  // the toggle menu hides it in both places without a second visibility rule.
  // The first visible column is the identifying one by convention — every
  // table puts its name/title first — and becomes the card's heading; what is
  // left splits into labelled detail rows and a pinned action row.
  const [headingColumn, ...secondaryColumns] = visibleColumns;
  const actionColumns = secondaryColumns.filter(isActionColumn);
  const detailColumns = secondaryColumns.filter((column) => !isActionColumn(column));

  // Sortable *and* visible: hiding a column already clears a sort applied to
  // it (see `onToggleColumn`), and offering it in the mobile picker would be
  // the same glitch by another route — rows reordered by something off screen.
  const sortableColumns = visibleColumns.filter((column) => column.sortValue);

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

  /**
   * The small-screen picker writes the *same* `sort` state the headers do, so
   * a sort chosen on a phone is still applied if the viewport widens — nothing
   * here is a parallel mode. It deliberately does not reproduce the headers'
   * third-click-clears cycle: choosing a column from a list is not a repeated
   * click, and "Default order" is already an entry in that list.
   */
  function onSelectSortColumn(value: string) {
    setPageIndex(0);
    if (value === UNSORTED_VALUE) {
      setSort(null);
      return;
    }

    const column = columns.find((one) => one.id === value);
    setSort({ columnId: value, direction: column?.firstSortDirection ?? "asc" });
  }

  function onToggleSortDirection() {
    setPageIndex(0);
    setSort((current) =>
      current
        ? {
            columnId: current.columnId,
            direction: current.direction === "asc" ? "desc" : "asc",
          }
        : current,
    );
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
  const showSortControl = sortableColumns.length > 0;

  // Shared by both layouts so the two can never drift into saying different
  // things about the same empty result.
  const emptyMessage = query ? (
    <>
      No rows match <span className="text-foreground font-medium">{query}</span>
    </>
  ) : (
    "Nothing to show"
  );

  return (
    <div className="space-y-3">
      {(showSearch || showColumnToggle || showSortControl) && (
        <div
          className={cn(
            "flex flex-wrap items-center gap-2",
            // A table whose only toolbar control is the mobile sort picker —
            // the provider table — would otherwise leave an empty flex row
            // above it on desktop, and `space-y-3` would still space it.
            !showSearch && !showColumnToggle && "md:hidden",
          )}
        >
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
          {showSortControl && (
            // Only below `md`, where the cards replace the header row: above
            // it the `<th>` buttons are the sort control, and a second one
            // beside them would be two widgets fighting over one state.
            <div className="flex items-center gap-2 md:hidden">
              <Select
                value={sort?.columnId ?? UNSORTED_VALUE}
                onValueChange={onSelectSortColumn}
              >
                {/* Labelled rather than given a visible caption: the toolbar
                    is tight at 375px, and the trigger already reads out the
                    column it is sorting by. */}
                <SelectTrigger size="sm" aria-label="Sort rows by">
                  <ArrowUpDown className="text-muted-foreground" />
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={UNSORTED_VALUE}>Default order</SelectItem>
                  {sortableColumns.map((column) => (
                    <SelectItem key={column.id} value={column.id}>
                      {column.header}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                variant="outline"
                size="icon-sm"
                onClick={onToggleSortDirection}
                disabled={!sort}
                // Cards carry no `aria-sort`, so this label is the only place
                // the current direction is announced — hence state *and*
                // action, rather than the bare "Reverse sort" the visual
                // arrow already implies.
                aria-label={
                  sort
                    ? `Sorted ${sort.direction === "asc" ? "ascending" : "descending"}, activate to reverse`
                    : "Sort direction"
                }
              >
                {sort?.direction === "desc" ? <ArrowDown /> : <ArrowUp />}
              </Button>
            </div>
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

      {showSortControl && (
        // VoiceOver and TalkBack announce neither `aria-sort` nor the arrow in
        // the header, so without this the only feedback for a sort is the rows
        // silently moving. Scoped to the sort state alone — the pagination
        // summary below is already a live region and already reports counts,
        // and two regions repeating each other on every keystroke is worse
        // than one saying slightly less.
        <p role="status" className="sr-only">
          {sort
            ? `Sorted by ${columns.find((one) => one.id === sort.columnId)?.header ?? sort.columnId}, ${sort.direction === "asc" ? "ascending" : "descending"}.`
            : "Default order."}
        </p>
      )}

      {/* Two layouts over one `pageRows`, rather than one table reflowed into
          cards with CSS: overriding `display` on rows and cells used to strip
          the grid's semantics outright, and while current browsers repair
          that, a second structure has no exposure to the bug class at all —
          the real table survives untouched above `md`, the cards live below
          it. Both branches sit in the DOM at every width, so each cell renders
          twice; `display: none` already takes the inactive branch out of the
          accessibility tree and out of the tab order, so no `aria-hidden` or
          `inert` is needed, but the render cost is real and is affordable only
          because a page here is at most 25 rows. */}
      <div className="hidden md:block">
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
                    // Only the sorted column carries `aria-sort`. Marking every
                    // sortable column `"none"` is legal but noisy: `none` is
                    // the default, so it adds nothing except a second thing
                    // for the operator to hear on each header they pass.
                    aria-sort={
                      sorted === "asc"
                        ? "ascending"
                        : sorted === "desc"
                          ? "descending"
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
                  {emptyMessage}
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
      </div>

      <div className="md:hidden">
        {pageRows.length === 0 ? (
          <Card size="sm">
            <CardContent className="text-muted-foreground py-4 text-center text-sm">
              {emptyMessage}
            </CardContent>
          </Card>
        ) : (
          // A list, not a stack of `<div>`s: the table it stands in for
          // announces how many rows there are, and `<ul>` is the only way to
          // keep that on a phone. `aria-label` carries the same string as the
          // table's `<caption>`, which is hidden along with the table here.
          <ul aria-label={caption} className="space-y-3">
            {pageRows.map((row) => {
              // Cells that render nothing are normal — the project table drops
              // its archive button once a project is archived — and a footer
              // rule above nothing looks like a broken card, so the action row
              // is decided per row rather than per table.
              const actions = actionColumns
                .map((column) => ({ column, node: column.cell(row) }))
                .filter((entry) => entry.node !== null && entry.node !== undefined);

              return (
                <li key={getRowId(row)}>
                  <Card size="sm">
                    <CardHeader>
                      {/* A heading, so the cards can be walked with a screen
                          reader's heading shortcut the way the rows of a
                          table can be walked with its table keys. `role` and
                          `aria-level` rather than a real `<h3>` because the
                          heading content is a consumer's `cell` output, and
                          two of them render paragraphs inside a link —
                          flow content an `<h3>` may not legally contain. */}
                      <CardTitle
                        role="heading"
                        aria-level={3}
                        // `min-w-0` because `CardHeader` is a grid and a grid
                        // item's automatic minimum size is its content's: the
                        // video title cell has a `truncate` second line, whose
                        // nowrap text pushed the whole header 490px wider than
                        // the card and was then silently cut off by the card's
                        // own `overflow-hidden` instead of ellipsised.
                        className={cn("min-w-0", headingColumn.cellClassName)}
                      >
                        {headingColumn.cell(row)}
                      </CardTitle>
                    </CardHeader>
                    {detailColumns.length > 0 && (
                      <CardContent>
                        {/* `<dl>` rather than two stacked lines per column:
                            the `header` string is genuinely the term for the
                            value beneath it, and the pairing is what a screen
                            reader loses when the `<th>` disappears. Empty
                            values keep their label, exactly as an empty cell
                            keeps its column. */}
                        <dl className="grid grid-cols-[minmax(0,7rem)_minmax(0,1fr)] gap-x-3 gap-y-2">
                          {detailColumns.map((column) => (
                            <Fragment key={column.id}>
                              <dt className="text-muted-foreground text-xs">
                                {column.header}
                              </dt>
                              {/* `align` is dropped on purpose: a right-edge
                                  value only reads as aligned against a column
                                  of its peers, and in a card it just floats
                                  away from the label it belongs to. */}
                              <dd className={cn("min-w-0 text-sm", column.cellClassName)}>
                                {column.cell(row)}
                              </dd>
                            </Fragment>
                          ))}
                        </dl>
                      </CardContent>
                    )}
                    {actions.length > 0 && (
                      // Pinned to the bottom and unlabelled: buttons say what
                      // they do, and "Actions" above them would be a heading
                      // for something already self-describing.
                      <CardFooter className="flex-wrap justify-end gap-2">
                        {actions.map((entry) => (
                          <Fragment key={entry.column.id}>{entry.node}</Fragment>
                        ))}
                      </CardFooter>
                    )}
                  </Card>
                </li>
              );
            })}
          </ul>
        )}
      </div>

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
 * Which columns are controls rather than data, and so belong at the foot of a
 * card instead of in its `<dl>`. Inferred rather than declared with a new
 * `role: "actions"` field: `id === "actions"` is the convention all three
 * tables with buttons already follow, and the right-aligned-and-always-visible
 * pair is what an actions column looks like even when it is named something
 * else — adding a flag would mean four call sites could forget to set it.
 */
function isActionColumn<Row>(column: DataTableColumn<Row>): boolean {
  return (
    column.id === "actions" ||
    (column.align === "right" && column.alwaysVisible === true)
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

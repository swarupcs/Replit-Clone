// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

/** A stand-in for Monaco. The real editor needs a canvas and a worker, and
 *  neither is the thing under test — what the filter box *does* with the text
 *  is. */
const editorProps = vi.hoisted(() => ({ current: null as Record<string, unknown> | null }));
// Registers the editor themes against the real Monaco, which cannot load
// here. The component under test only needs the theme NAMES, and those
// live in editorThemes.ts, which this does not touch.
vi.mock("../../../config/monacoSetup.ts", () => ({}));

vi.mock("@monaco-editor/react", () => ({
  default: (props: Record<string, unknown>) => {
    editorProps.current = props;
    return (
      <textarea
        aria-label="query"
        value={props["value"] as string}
        onChange={(event) => (props["onChange"] as (v: string) => void)(event.target.value)}
      />
    );
  },
}));

vi.mock("../../../hooks/useThemeMode.ts", () => ({ useThemeMode: () => "dark" }));

const {
  getMongoCollectionsApi,
  getMongoCollectionSchemaApi,
  runMongoQueryApi,
} = vi.hoisted(() => ({
  getMongoCollectionsApi: vi.fn(),
  getMongoCollectionSchemaApi: vi.fn(),
  runMongoQueryApi: vi.fn(),
}));
vi.mock("../../../apis/projects.ts", () => ({
  getMongoCollectionsApi,
  getMongoCollectionSchemaApi,
  runMongoQueryApi,
}));

const { MongoWorkbench } = await import("./MongoWorkbench.tsx");

const COLLECTIONS = [
  { database: "shop", name: "orders", kind: "collection" as const },
  { database: "shop", name: "recent", kind: "view" as const },
];

const RESULT = {
  documents: [
    { _id: { $oid: "651f1f77bcf86cd799439011" }, total: 12.5 },
    { _id: { $oid: "651f1f77bcf86cd799439012" }, total: 3 },
  ],
  fields: ["_id", "total"],
  documentCount: 2,
  truncated: false,
  durationMs: 4,
};

const renderPanel = () =>
  render(
    <MongoWorkbench
      projectId="p1"
      label="db.example.com:27017"
      isOwner
      onDisconnect={() => undefined}
    />,
  );

// `globals` is off in this project's vitest config, so testing-library's
// automatic cleanup never runs and each render would stack another copy of
// the tree onto the same document.
afterEach(cleanup);

beforeEach(() => {
  vi.clearAllMocks();
  getMongoCollectionsApi.mockResolvedValue(COLLECTIONS);
  runMongoQueryApi.mockResolvedValue(RESULT);
  getMongoCollectionSchemaApi.mockResolvedValue({
    database: "shop",
    collection: "orders",
    sampled: 40,
    fields: [
      { name: "_id", types: ["objectid"], presence: 1 },
      { name: "coupon", types: ["string", "null"], presence: 0.15 },
    ],
  });
});

describe("MongoWorkbench", () => {
  it("lists the collections and marks a view as one", async () => {
    renderPanel();
    expect(await screen.findByRole("button", { name: "orders" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /recent/ })).toBeTruthy();
    expect(screen.getByText("view")).toBeTruthy();
  });

  it("samples a collection only when it is expanded", async () => {
    renderPanel();
    await screen.findByRole("button", { name: "orders" });

    // Not on load: eager inference would be one $sample per collection every
    // time the panel opens.
    expect(getMongoCollectionSchemaApi).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "orders" }));
    await waitFor(() =>
      expect(getMongoCollectionSchemaApi).toHaveBeenCalledWith("p1", "shop", "orders"),
    );
  });

  it("says the field list is inferred, and from how many documents", async () => {
    renderPanel();
    fireEvent.click(await screen.findByRole("button", { name: "orders" }));

    // The whole point of §7.6's wording: a sampled field list presented as
    // truth is the way this view would lie.
    expect(
      await screen.findByText(/inferred from 40 sampled documents/i),
    ).toBeTruthy();
  });

  it("shows how often an inconsistent field actually appears", async () => {
    renderPanel();
    fireEvent.click(await screen.findByRole("button", { name: "orders" }));

    expect(await screen.findByText("15%")).toBeTruthy();
    // A field that is always there needs no qualifier.
    expect(screen.queryByText("100%")).toBeNull();
  });

  it("does not re-sample a collection that was already sampled", async () => {
    renderPanel();
    const node = await screen.findByRole("button", { name: "orders" });

    fireEvent.click(node);
    await screen.findByText(/inferred from 40/i);
    fireEvent.click(node);
    fireEvent.click(node);

    expect(getMongoCollectionSchemaApi).toHaveBeenCalledTimes(1);
  });

  it("sends a filter document, not SQL", async () => {
    renderPanel();
    await screen.findByRole("button", { name: "orders" });

    fireEvent.click(screen.getByRole("button", { name: /^Run$/ }));

    await waitFor(() =>
      expect(runMongoQueryApi).toHaveBeenCalledWith("p1", {
        database: "shop",
        collection: "orders",
        mode: "find",
        text: "{}",
        limit: 50,
        skip: 0,
      }),
    );
  });

  it("switches the untouched default to an array when the mode becomes a pipeline", async () => {
    // A leftover `{}` in the pipeline box is an error, not an empty query.
    renderPanel();
    await screen.findByRole("button", { name: "orders" });

    fireEvent.click(screen.getByRole("radio", { name: "Pipeline" }));

    const box = screen.getByLabelText<HTMLTextAreaElement>("query");
    expect(box.value.trim().startsWith("[")).toBe(true);
  });

  it("leaves text the user typed alone when the mode changes", async () => {
    renderPanel();
    await screen.findByRole("button", { name: "orders" });

    const box = screen.getByLabelText("query");
    fireEvent.change(box, { target: { value: '{"total": 1}' } });

    fireEvent.click(screen.getByRole("radio", { name: "Pipeline" }));
    expect((box as HTMLTextAreaElement).value).toContain('"total"');
  });

  it("shows documents rather than a grid by default", async () => {
    renderPanel();
    await screen.findByRole("button", { name: "orders" });
    fireEvent.click(screen.getByRole("button", { name: /^Run$/ }));

    // §7.6: a document is not a row, and a grid flattens it badly — so the
    // document view is the primary one and the table is the alternative.
    expect(await screen.findByText(/total: 12.5/)).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("offers the flattened table as a second view", async () => {
    renderPanel();
    await screen.findByRole("button", { name: "orders" });
    fireEvent.click(screen.getByRole("button", { name: /^Run$/ }));
    await screen.findByText(/total: 12.5/);

    fireEvent.click(screen.getByLabelText("Show a table"));
    expect(screen.getByRole("table")).toBeTruthy();
  });

  it("pages with skip rather than fetching everything", async () => {
    runMongoQueryApi.mockResolvedValue({ ...RESULT, truncated: true });
    renderPanel();
    await screen.findByRole("button", { name: "orders" });

    fireEvent.click(screen.getByRole("button", { name: /^Run$/ }));
    await screen.findByText(/total: 12.5/);

    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() =>
      expect(runMongoQueryApi).toHaveBeenLastCalledWith(
        "p1",
        expect.objectContaining({ skip: 50 }),
      ),
    );
  });

  it("does not offer Next when the result was not truncated", async () => {
    renderPanel();
    await screen.findByRole("button", { name: "orders" });
    fireEvent.click(screen.getByRole("button", { name: /^Run$/ }));
    await screen.findByText(/total: 12.5/);

    expect(
      screen.getByRole<HTMLButtonElement>("button", { name: "Next" }).disabled,
    ).toBe(true);
  });
});

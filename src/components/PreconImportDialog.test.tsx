// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import PreconImportDialog from "./PreconImportDialog";

afterEach(cleanup);

const decks = Array.from({ length: 150 }, (_, i) => ({
  fileName: `Deck${i}_C${i}`,
  name: `Commander Deck ${i}`,
  code: `C${i}`,
  type: "Commander Deck",
  releaseDate: `20${String(10 + Math.floor(i / 12)).padStart(2, "0")}-01-01`
})).concat([{ fileName: "Duel_1", name: "Duell Deck", code: "DD1", type: "Duel Deck", releaseDate: "2012-01-01" }]);

vi.mock("../precons", async importOriginal => ({
  ...(await importOriginal<typeof import("../precons")>()),
  loadPreconDeckList: vi.fn(async () => decks)
}));

const open = () => render(<PreconImportDialog collection={[]} onClose={() => {}} onAddCards={async () => {}} onSaveDeck={async () => {}} />);

describe("Precon-Liste", () => {
  it("zeigt nicht nur 60 Decks, sondern lässt sich vollständig aufklappen", async () => {
    open();
    const list = await screen.findByRole("list");
    await waitFor(() => expect(within(list).getAllByRole("listitem")).toHaveLength(60));
    expect(screen.getByText(/60 von 150 Decks angezeigt \(insgesamt 151 verfügbar\)/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Mehr anzeigen/ }));
    expect(within(list).getAllByRole("listitem")).toHaveLength(120);
    fireEvent.click(screen.getByRole("button", { name: /Alle anzeigen/ }));
    expect(within(list).getAllByRole("listitem")).toHaveLength(150);
    expect(screen.queryByRole("button", { name: /Mehr anzeigen/ })).toBeNull();
  });

  it("der Typ-Filter nennt die Anzahl je Produkttyp; „Alle Typen“ zeigt auch Duel Decks", async () => {
    open();
    await screen.findByRole("list");
    expect(screen.getByRole("option", { name: "Alle Typen (151)" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "Duel Deck (1)" })).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Produkttyp"), { target: { value: "" } });
    fireEvent.change(screen.getByPlaceholderText(/Name, Setcode/), { target: { value: "Duell" } });
    expect(screen.getByText("Duell Deck")).toBeTruthy();
  });
});

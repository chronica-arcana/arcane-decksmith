// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GameApi, HistoryEntry } from "../../gameClient";
import HistoryPanel from "./HistoryPanel";

afterEach(cleanup);

const entry = (id: string, won: boolean, aborted = false): HistoryEntry => ({
  id, code: "ABCDEF", format: "commander", aborted, winner: null, won, turns: 7, startedAt: 0, endedAt: 1000,
  players: [{ userId: "a", name: "Ana", deckName: "Elfen", eliminated: null, life: 5 }, { userId: "b", name: "Bo", deckName: "Zombies", eliminated: "aufgegeben", life: 0 }]
});

describe("HistoryPanel", () => {
  it("zeigt Bilanz und Einträge", async () => {
    const api = { getHistory: vi.fn().mockResolvedValue([entry("1", true), entry("2", false), entry("3", false, true)]) } as unknown as GameApi;
    render(<HistoryPanel api={api} />);
    expect(await screen.findByText(/1 Siege, 1 Niederlagen/)).toBeTruthy();
    expect(screen.getAllByText(/Ana \(Elfen\) gegen Bo \(Zombies\)/)).toHaveLength(3);
    expect(screen.getByText("abgebrochen")).toBeTruthy();
  });

  it("leerer Verlauf und Fehler", async () => {
    const { unmount } = render(<HistoryPanel api={{ getHistory: vi.fn().mockResolvedValue([]) } as unknown as GameApi} />);
    expect(await screen.findByText(/Noch keine Spiele/)).toBeTruthy();
    unmount();
    render(<HistoryPanel api={{ getHistory: vi.fn().mockRejectedValue(new Error("x")) } as unknown as GameApi} />);
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", expect.stringContaining("Verlauf"));
  });
});

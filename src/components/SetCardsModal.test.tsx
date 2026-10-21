// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ScryfallCard } from "../scryfall";
import type { CardRecord } from "../types";

const getSetCards = vi.fn();
vi.mock("../scryfall", () => ({
  getSetCards: (code: string) => getSetCards(code),
  imageFor: (card: { image_uris?: { normal?: string } }) => card.image_uris?.normal
}));

import SetCardsModal from "./SetCardsModal";

const setCard = (id: string, name: string, cn: string, image = true) => ({
  id, name, set: "neo", collector_number: cn, rarity: "rare",
  ...(image ? { image_uris: { normal: `https://cards.scryfall.io/${id}.jpg` } } : {})
}) as unknown as ScryfallCard;

const owned = (cn: string, count: number) => ({ id: `o${cn}`, set: "neo", collectorNumber: cn, count }) as CardRecord;

const cards = [setCard("a", "Besessene Karte", "1"), setCard("b", "Fehlende Karte", "2"), setCard("c", "Ohne Bild", "3", false)];

beforeEach(() => {
  getSetCards.mockReset();
});

afterEach(() => {
  cleanup();
});

const renderModal = (onClose = vi.fn()) =>
  render(<SetCardsModal setCode="neo" setName="Kamigawa: Neon Dynasty" ownedCards={[owned("1", 3)]} onClose={onClose} />);

describe("SetCardsModal", () => {
  it("zeigt alle Karten, besessene mit Anzahl und fehlende ausgegraut", async () => {
    getSetCards.mockResolvedValue(cards);
    renderModal();

    expect(screen.getByText(/Karten des Sets werden geladen/)).toBeTruthy();
    await screen.findByText("Besessene Karte");

    expect(getSetCards).toHaveBeenCalledWith("neo");
    expect(screen.getByText("3×")).toBeTruthy();
    expect(screen.getByText(/1 \/ 3 Karten · 33 %/)).toBeTruthy();

    const owned = screen.getByRole("article", { name: /Besessene Karte.*3 mal im Besitz/ });
    const missing = screen.getByRole("article", { name: /Fehlende Karte.*nicht im Besitz/ });
    expect(owned.className).not.toContain("set-card-missing");
    expect(missing.className).toContain("set-card-missing");
    expect(screen.getByText("Kein Bild")).toBeTruthy();
  });

  it("filtert auf vorhanden und fehlend", async () => {
    getSetCards.mockResolvedValue(cards);
    renderModal();
    await screen.findByText("Besessene Karte");

    fireEvent.click(screen.getByRole("button", { name: "Fehlend" }));
    expect(screen.queryByText("Besessene Karte")).toBeNull();
    expect(screen.getByText("Fehlende Karte")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Vorhanden" }));
    expect(screen.getByText("Besessene Karte")).toBeTruthy();
    expect(screen.queryByText("Fehlende Karte")).toBeNull();
  });

  it("meldet Ladefehler und lädt auf Wunsch erneut", async () => {
    getSetCards.mockRejectedValueOnce(new Error("Scryfall-Fehler 500.")).mockResolvedValueOnce(cards);
    renderModal();

    await screen.findByText(/Scryfall-Fehler 500/);
    fireEvent.click(screen.getByRole("button", { name: "Erneut versuchen" }));
    await screen.findByText("Besessene Karte");
    expect(getSetCards).toHaveBeenCalledTimes(2);
  });

  it("schließt per Schaltfläche", async () => {
    getSetCards.mockResolvedValue(cards);
    const onClose = vi.fn();
    renderModal(onClose);
    await screen.findByText("Besessene Karte");

    fireEvent.click(screen.getByRole("button", { name: "Fenster schließen" }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });
});

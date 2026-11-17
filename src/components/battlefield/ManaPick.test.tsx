// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GameCard } from "../../gameClient";
import ManaPick from "./ManaPick";

afterEach(cleanup);

const land = (id: string, name: string, color: string) =>
  ({ id, name, mana: true, manaColors: [color], tapped: false, sick: false }) as unknown as GameCard;

describe("ManaPick", () => {
  it("bezahlt nur mit den angetippten Ländern", () => {
    const onPay = vi.fn();
    render(<ManaPick name="Bär" cost="{1}{G}" sources={[land("a", "Wald", "G"), land("b", "Insel", "U")]} onPay={onPay} onAuto={() => {}} onCancel={() => {}} />);
    const pay = screen.getByRole("button", { name: "Mit Auswahl bezahlen" }) as HTMLButtonElement;
    expect(pay.disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: /Wald/ }));
    fireEvent.click(screen.getByRole("button", { name: /Insel/ }));
    fireEvent.click(pay);
    expect(onPay).toHaveBeenCalledWith(["a", "b"]);
  });

  it("bietet automatisches Bezahlen an", () => {
    const onAuto = vi.fn();
    render(<ManaPick name="Bär" cost="{G}" sources={[land("a", "Wald", "G")]} onPay={() => {}} onAuto={onAuto} onCancel={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Automatisch bezahlen" }));
    expect(onAuto).toHaveBeenCalled();
  });
});

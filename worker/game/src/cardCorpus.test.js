import { describe, expect, it } from "vitest";
import { parseCardText } from "./cardText.js";
import { CORPUS } from "./cardCorpus.js";

const KEYWORD_LINE = /^(Flying|Vigilance|Reach|Haste|Trample|Deathtouch|Lifelink|Menace|Flash|Hexproof|Defender|Indestructible|First strike)/i;

/** Wird der Kartentext vollständig verstanden? (Nichts Unverstandenes, keine ignorierten Sonderregeln.) */
export function fullyParsed([name, typeLine, oracleText]) {
  const r = parseCardText({ name, typeLine, oracleText });
  const unparsed = [
    ...(r.spell?.unparsed ?? []),
    ...(r.spell?.modes?.flatMap(mode => mode.unparsed) ?? []),
    ...r.triggers.flatMap(trigger => trigger.unparsed),
    ...r.activated.flatMap(ability => ability.unparsed)
  ];
  return unparsed.length === 0 && r.notes.filter(note => !KEYWORD_LINE.test(note)).length === 0;
}

describe("Abdeckung der Kartentexte", () => {
  it("mindestens 60 % der Stichprobe werden vollständig automatisch verstanden (Ziel: weiter steigern)", () => {
    const failed = CORPUS.filter(entry => !fullyParsed(entry)).map(entry => entry[0]);
    const share = 1 - failed.length / CORPUS.length;
    expect(share, `Nicht automatisch: ${failed.join(", ")}`).toBeGreaterThanOrEqual(0.6);
  });

  it("die Karten aus den Rückmeldungen laufen automatisch", () => {
    const names = ["Thickest in the Thicket", "Rabid Bite", "Prey Upon", "Bojuka Bog", "White Auracite", "Oblivion Ring", "Doom Blade", "Retrieve the Esper"];
    for (const name of names) {
      const entry = CORPUS.find(item => item[0] === name);
      if (entry) expect(fullyParsed(entry), name).toBe(true);
    }
  });
});

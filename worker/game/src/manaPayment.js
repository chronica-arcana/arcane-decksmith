/**
 * Mana bezahlen: aus dem Manapool und durch automatisches Tappen von Manaquellen.
 * Farbige Kosten werden per Zuordnung (Matching) gedeckt, der Rest mit den am wenigsten flexiblen Quellen.
 */
import { parseManaCost } from "./cardFacts.js";

const COLORS = ["W", "U", "B", "R", "G", "C"];

export const emptyPool = () => ({ W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 });
export const poolTotal = pool => COLORS.reduce((sum, color) => sum + (pool[color] ?? 0), 0);

/** Textform für Meldungen, z. B. "{2}{W}". */
export function describeCost(manaCost, x = 0, extraGeneric = 0) {
  const parsed = parseManaCost(manaCost);
  const parts = [];
  const generic = Math.max(0, parsed.generic + parsed.x * x + extraGeneric);
  if (generic > 0) parts.push(`{${generic}}`);
  for (const req of parsed.reqs) parts.push(`{${req.opts.join("/")}}`);
  return parts.join("") || "{0}";
}

function solve(reqs, generic, units) {
  // Zuordnung farbiger Kosten zu Einheiten (Kuhn-Algorithmus); wenig flexible Einheiten zuerst.
  const order = units.map((_, i) => i).sort((a, b) => units[a].opts.length - units[b].opts.length);
  const owner = new Map(); // Einheit → Kostenindex
  const tryAssign = (reqIndex, seen) => {
    for (const u of order) {
      if (seen.has(u) || !reqs[reqIndex].opts.some(color => units[u].opts.includes(color))) continue;
      seen.add(u);
      if (!owner.has(u) || tryAssign(owner.get(u), seen)) {
        owner.set(u, reqIndex);
        return true;
      }
    }
    return false;
  };
  for (let r = 0; r < reqs.length; r += 1) if (!tryAssign(r, new Set())) return null;

  const used = new Set(owner.keys());
  const tapped = new Set([...used].map(u => units[u].src).filter(src => src !== null));

  let remaining = generic;
  const take = u => {
    used.add(u);
    remaining -= 1;
  };
  // 1) übrige Einheiten bereits getappter Quellen, 2) Pool, 3) weitere Quellen (am wenigsten flexibel zuerst)
  for (const u of order) if (remaining > 0 && !used.has(u) && units[u].src !== null && tapped.has(units[u].src)) take(u);
  for (const u of order) if (remaining > 0 && !used.has(u) && units[u].src === null) take(u);
  for (const u of order) {
    if (remaining <= 0) break;
    if (used.has(u) || units[u].src === null || tapped.has(units[u].src)) continue;
    tapped.add(units[u].src);
    for (const other of order) if (units[other].src === units[u].src && !used.has(other) && remaining > 0) take(other);
  }
  if (remaining > 0) return null;
  return { used, tapped };
}

/**
 * Plant die Bezahlung.
 * @param {{ manaCost: string, x?: number, extraGeneric?: number, pool: object, sources: Array<{id: string, units: string[][]}> }} input
 * @returns {{ ok: true, tap: string[], poolUsed: object, poolAdd: object, lifeLoss: number } | { ok: false, missing: string }}
 */
export function planPayment({ manaCost, x = 0, extraGeneric = 0, pool, sources }) {
  const parsed = parseManaCost(manaCost);
  const units = [];
  for (const color of COLORS) for (let i = 0; i < (pool[color] ?? 0); i += 1) units.push({ src: null, opts: [color] });
  for (const source of sources) for (const opts of source.units) units.push({ src: source.id, opts });

  const baseGeneric = Math.max(0, parsed.generic + parsed.x * x + extraGeneric);
  const attempts = [];
  attempts.push({ reqs: parsed.reqs, generic: baseGeneric, life: 0 });
  if (parsed.reqs.some(req => req.kind === "twobrid")) {
    const twos = parsed.reqs.filter(req => req.kind === "twobrid").length;
    attempts.push({ reqs: parsed.reqs.filter(req => req.kind !== "twobrid"), generic: baseGeneric + 2 * twos, life: 0 });
  }
  if (parsed.reqs.some(req => req.kind === "phyrexian")) {
    const phys = parsed.reqs.filter(req => req.kind === "phyrexian").length;
    attempts.push({ reqs: parsed.reqs.filter(req => req.kind !== "phyrexian"), generic: baseGeneric, life: 2 * phys });
  }

  for (const attempt of attempts) {
    const plan = solve(attempt.reqs, attempt.generic, units);
    if (!plan) continue;
    const poolUsed = emptyPool();
    const poolAdd = emptyPool();
    for (const u of plan.used) if (units[u].src === null) poolUsed[units[u].opts[0]] += 1;
    // Überschüssiges Mana getappter Quellen bleibt im Pool
    units.forEach((unit, u) => {
      if (unit.src !== null && plan.tapped.has(unit.src) && !plan.used.has(u)) poolAdd[unit.opts[0]] += 1;
    });
    return { ok: true, tap: [...plan.tapped], poolUsed, poolAdd, lifeLoss: attempt.life };
  }
  return { ok: false, missing: describeCost(manaCost, x, extraGeneric) };
}

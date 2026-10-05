/**
 * Arcane Decksmith – Import-Proxy als Cloudflare Worker (kostenloser Tarif).
 *
 * Ersetzt die Firebase Cloud Function `importExternalDeckUrl`, damit der
 * Deck-Import per Link ohne Firebase-Blaze-Plan funktioniert.
 *
 * Aufruf (vom Browser):  GET https://<worker>.workers.dev/?url=<Deck-URL>
 * Antwort:               JSON { provider, deckName, format?, rows[], sourceUrl }
 *                        oder { error } mit passendem HTTP-Status.
 *
 * Unterstützt: Moxfield, Archidekt, Deckstats (öffentliche Decks).
 *
 * Einstellungen (Cloudflare → Worker → Settings → Variables):
 *   ALLOWED_ORIGINS  Kommagetrennte Liste erlaubter Seiten, z. B.
 *                    https://chronica-arcana.github.io
 *                    Ohne Wert darf jede Webseite den Worker per Browser aufrufen.
 */

const USER_AGENT =
  "Mozilla/5.0 (compatible; ArcaneDecksmith/1.0; +https://github.com/)";
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;

function clean(value) {
  return typeof value === "string" ? value.trim() : "";
}

function positiveInt(value, fallback = 1) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function decodeHtml(value) {
  return String(value ?? "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(Number.parseInt(code, 16)));
}

function stripTags(value) {
  return decodeHtml(String(value ?? "").replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

// Nur diese Hosts dürfen abgerufen werden – auch nach Redirects.
const ALLOWED_HOSTS = new Set([
  "moxfield.com",
  "www.moxfield.com",
  "api.moxfield.com",
  "api2.moxfield.com",
  "archidekt.com",
  "www.archidekt.com",
  "deckstats.net",
  "www.deckstats.net"
]);
const MAX_REDIRECTS = 3;

function assertAllowedUrl(url) {
  if (url.protocol !== "https:" || !ALLOWED_HOSTS.has(url.hostname.toLowerCase())) {
    throw new Error("Weiterleitung auf einen nicht erlaubten Host wurde blockiert.");
  }
}

async function readBodyLimited(response) {
  const declared = Number(response.headers.get("content-length") || 0);
  if (declared > MAX_RESPONSE_BYTES) throw new Error("Die Antwort des Anbieters ist zu groß.");
  if (!response.body) return "";

  // Body streamen und beim Limit sofort abbrechen, statt alles zu puffern.
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => {});
      throw new Error("Die Antwort des Anbieters ist zu groß.");
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

async function fetchLimited(url, accept = "application/json, text/plain, text/html;q=0.9, */*;q=0.8") {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);

  try {
    let current = new URL(url);
    for (let redirects = 0; ; redirects += 1) {
      assertAllowedUrl(current);
      const response = await fetch(current, {
        redirect: "manual",
        signal: controller.signal,
        headers: {
          Accept: accept,
          "Accept-Language": "de-DE,de;q=0.9,en;q=0.8",
          "User-Agent": USER_AGENT
        }
      });

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location || redirects >= MAX_REDIRECTS) {
          throw new Error("Zu viele oder ungültige Weiterleitungen.");
        }
        current = new URL(location, current);
        continue;
      }

      if (!response.ok) {
        throw new Error(`Der Anbieter antwortete mit HTTP ${response.status}.`);
      }

      return {
        url: current.toString(),
        contentType: response.headers.get("content-type") || "",
        text: await readBodyLimited(response)
      };
    }
  } finally {
    clearTimeout(timer);
  }
}

function sectionForBoard(name) {
  const value = String(name || "").toLowerCase();
  if (value.includes("commander")) return "commander";
  if (value.includes("side") || value.includes("maybe") || value.includes("consider")) return "sideboard";
  return "main";
}

function foilFromUnknown(...values) {
  for (const value of values) {
    if (value === true) return true;
    const text = String(value ?? "").toLowerCase();
    if (/foil|etched/.test(text)) return true;
  }
  return false;
}

function moxfieldRows(data) {
  const rows = [];
  const boards = [
    ["commanders", data.commanders],
    ["mainboard", data.mainboard],
    ["sideboard", data.sideboard],
    ["maybeboard", data.maybeboard]
  ];

  for (const [boardName, board] of boards) {
    if (!board) continue;
    const entries = Array.isArray(board) ? board : Object.values(board);

    for (const entry of entries) {
      const card = entry?.card ?? entry ?? {};
      const name = clean(card.name || entry?.name);
      if (!name) continue;

      const edition = clean(card.set || card.setCode || card.edition || entry?.set);
      const collectorNumber = clean(
        card.cn || card.collector_number || card.collectorNumber || entry?.cn || entry?.collectorNumber
      );

      rows.push({
        count: positiveInt(entry?.quantity ?? entry?.count, 1),
        name,
        ...(edition ? { edition } : {}),
        ...(collectorNumber ? { collectorNumber } : {}),
        foil: foilFromUnknown(entry?.finish, entry?.isFoil, entry?.foil, card.finish, card.isFoil, card.foil),
        section: sectionForBoard(boardName)
      });
    }
  }

  return rows;
}

async function importMoxfield(sourceUrl) {
  const match = sourceUrl.pathname.match(/\/decks\/([^/?#]+)/i);
  if (!match) throw new Error("Moxfield-Deck-ID konnte aus der URL nicht gelesen werden.");
  const id = match[1];

  const endpoints = [
    `https://api2.moxfield.com/v3/decks/all/${encodeURIComponent(id)}`,
    `https://api2.moxfield.com/v2/decks/all/${encodeURIComponent(id)}`,
    `https://api.moxfield.com/v2/decks/all/${encodeURIComponent(id)}`
  ];

  let lastError;
  for (const endpoint of endpoints) {
    try {
      const response = await fetchLimited(endpoint, "application/json");
      const data = JSON.parse(response.text);
      const rows = moxfieldRows(data);
      if (!rows.length) throw new Error("Moxfield lieferte keine Karten.");
      return {
        provider: "Moxfield",
        deckName: clean(data.name) || "Importiertes Moxfield-Deck",
        format: rows.some(row => row.section === "commander") ? "commander" : undefined,
        rows,
        sourceUrl: sourceUrl.toString()
      };
    } catch (error) {
      lastError = error;
    }
  }

  // Moxfield blockiert automatisierte Abrufe regelmäßig (Cloudflare). Klare
  // Meldung mit Ausweichweg statt eines technischen Fehlers.
  const detail = lastError instanceof Error ? ` (${lastError.message})` : "";
  throw new Error(
    `Moxfield hat den Abruf abgelehnt oder ist nicht erreichbar${detail}. ` +
    "Bitte das Deck in Moxfield als CSV/TXT exportieren und die Datei hier importieren."
  );
}

function archidektEdition(card) {
  const edition = card?.edition ?? card?.set ?? {};
  if (typeof edition === "string") return edition;
  return clean(
    edition.editioncode || edition.editionCode || edition.code || card?.setCode || card?.set_code
  );
}

function archidektCollector(card) {
  return clean(
    card?.collectorNumber || card?.collector_number || card?.collectorNum || card?.number
  );
}

async function importArchidekt(sourceUrl) {
  const match = sourceUrl.pathname.match(/\/decks\/(\d+)/i);
  if (!match) throw new Error("Archidekt-Deck-ID konnte aus der URL nicht gelesen werden.");
  const id = match[1];
  const response = await fetchLimited(`https://archidekt.com/api/decks/${id}/`, "application/json");
  const data = JSON.parse(response.text);
  const rows = [];

  for (const entry of data.cards || []) {
    const card = entry?.card ?? {};
    const oracle = card.oracleCard ?? card.oracle_card ?? {};
    const name = clean(oracle.name || card.name);
    if (!name) continue;

    const categories = Array.isArray(entry.categories)
      ? entry.categories.map(category => typeof category === "string" ? category : category?.name).filter(Boolean)
      : [entry.category].filter(Boolean);
    const categoryText = categories.join(" ").toLowerCase();
    const section = categoryText.includes("commander")
      ? "commander"
      : categoryText.includes("sideboard") || categoryText.includes("maybeboard")
        ? "sideboard"
        : "main";

    const edition = archidektEdition(card);
    const collectorNumber = archidektCollector(card);

    rows.push({
      count: positiveInt(entry.quantity, 1),
      name,
      ...(edition ? { edition } : {}),
      ...(collectorNumber ? { collectorNumber } : {}),
      foil: foilFromUnknown(entry.modifier, entry.finish, entry.foil, card.foil),
      section
    });
  }

  if (!rows.length) throw new Error("Archidekt lieferte keine Karten.");

  return {
    provider: "Archidekt",
    deckName: clean(data.name) || "Importiertes Archidekt-Deck",
    format: rows.some(row => row.section === "commander") || Number(data.deckFormat) === 3
      ? "commander"
      : undefined,
    rows,
    sourceUrl: sourceUrl.toString()
  };
}

function parsePrintingSuffix(payload) {
  let text = payload.trim();
  let foil = false;
  if (/\s+(?:\*f\*|\[foil\]|\(foil\)|foil)\s*$/i.test(text)) {
    foil = true;
    text = text.replace(/\s+(?:\*f\*|\[foil\]|\(foil\)|foil)\s*$/i, "").trim();
  }

  const patterns = [
    /^(.+?)\s+\[([a-z0-9]+):([^\]]+)\]\s*$/i,
    // Wie parseExternalText im Client: Collector Numbers mit Sonderzeichen (A-69, 123★).
    /^(.+?)\s+\(([a-z0-9]+)\)\s+([a-z0-9][^\s]*)\s*$/i,
    /^(.+?)\s+\[([a-z0-9]+)\]\s+([a-z0-9][^\s]*)\s*$/i
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      return { name: match[1].trim(), edition: match[2].trim(), collectorNumber: match[3].trim(), foil };
    }
  }

  return { name: text, foil };
}

function rowsFromDeckText(text) {
  const rows = [];
  let section = "main";

  for (const raw of text.split(/\r?\n/)) {
    const line = decodeHtml(raw).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    if (!line) continue;
    const heading = line.replace(/^\/+/, "").replace(/:$/, "").trim().toLowerCase();
    if (["commander", "commanders"].includes(heading)) { section = "commander"; continue; }
    if (["sideboard", "side board", "maybeboard", "considering"].includes(heading)) { section = "sideboard"; continue; }
    if (["main", "mainboard", "deck", "maindeck", "main deck"].includes(heading)) { section = "main"; continue; }

    let cardLine = line;
    let rowSection = section;
    if (cardLine.endsWith("#!Commander")) {
      rowSection = "commander";
      cardLine = cardLine.replace(/#!Commander\s*$/, "").trim();
    }

    const match = cardLine.match(/^\s*(\d+)\s*x?\s+(.+?)\s*$/i);
    if (!match) continue;
    // Wie im Client: Anzahl 0 wird übersprungen, nicht zu 1.
    if (Number.parseInt(match[1], 10) <= 0) continue;
    const parsed = parsePrintingSuffix(match[2]);
    if (!parsed.name) continue;
    rows.push({
      count: positiveInt(match[1], 1),
      name: parsed.name,
      ...(parsed.edition ? { edition: parsed.edition } : {}),
      ...(parsed.collectorNumber ? { collectorNumber: parsed.collectorNumber } : {}),
      foil: parsed.foil,
      section: rowSection
    });
  }

  return rows;
}

function deckstatsRowsFromHtml(html) {
  // Deckstats pages frequently contain the decklist in a textarea used by the editor/export tools.
  const textareaMatches = [...html.matchAll(/<textarea\b[^>]*>([\s\S]*?)<\/textarea>/gi)]
    .map(match => decodeHtml(match[1]))
    .map(text => ({ text, rows: rowsFromDeckText(text) }))
    .sort((a, b) => b.rows.length - a.rows.length);

  if (textareaMatches[0]?.rows.length >= 3) return textareaMatches[0].rows;

  // Fallback for public read-only pages: read rows that contain a Deckstats card link.
  const rows = [];
  for (const match of html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const rowHtml = match[1];
    if (!/cards\.deckstats\.net\/magiccard\.php/i.test(rowHtml)) continue;

    const countMatch = stripTags(rowHtml).match(/^\s*(\d+)\s+/);
    const cardLink = rowHtml.match(/<a\b[^>]*href=["']([^"']*cards\.deckstats\.net\/magiccard\.php[^"']*)["'][^>]*>([\s\S]*?)<\/a>/i);
    if (!cardLink) continue;

    const name = stripTags(cardLink[2]);
    if (!name) continue;
    let edition = "";
    let collectorNumber = "";
    try {
      const href = new URL(decodeHtml(cardLink[1]), "https://deckstats.net/");
      edition = clean(href.searchParams.get("set") || href.searchParams.get("edition") || href.searchParams.get("set_code"));
      collectorNumber = clean(
        href.searchParams.get("collector_number") || href.searchParams.get("collectorNumber") || href.searchParams.get("cn")
      );
    } catch {}

    const text = stripTags(rowHtml).toLowerCase();
    rows.push({
      count: positiveInt(countMatch?.[1], 1),
      name,
      ...(edition ? { edition } : {}),
      ...(collectorNumber ? { collectorNumber } : {}),
      foil: /\bfoil\b|\*f\*/i.test(text),
      section: /commander/i.test(text) ? "commander" : /sideboard|maybeboard/i.test(text) ? "sideboard" : "main"
    });
  }

  return rows;
}

async function importDeckstats(sourceUrl) {
  const response = await fetchLimited(sourceUrl.toString(), "text/html, text/plain;q=0.9, */*;q=0.8");
  const rows = response.contentType.includes("text/plain")
    ? rowsFromDeckText(response.text)
    : deckstatsRowsFromHtml(response.text);

  if (!rows.length) {
    throw new Error(
      "Der öffentliche Deckstats-Link konnte nicht zuverlässig ausgelesen werden. Bitte dort eine CSV/TXT/DEC-Datei exportieren und diese hier hochladen."
    );
  }

  const title = stripTags(response.text.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] || "")
    .replace(/\s+[—-]\s+Deckstats.*$/i, "")
    .replace(/\s+\([^)]*\)\s*$/, "")
    .trim();

  return {
    provider: "Deckstats",
    deckName: title || "Importiertes Deckstats-Deck",
    format: rows.some(row => row.section === "commander") ? "commander" : undefined,
    rows,
    sourceUrl: sourceUrl.toString()
  };
}

function providerFor(url) {
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  if (host === "moxfield.com") return "moxfield";
  if (host === "archidekt.com") return "archidekt";
  if (host === "deckstats.net") return "deckstats";
  return null;
}


const JSON_HEADERS = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" };

function allowedOrigins(env) {
  return String(env?.ALLOWED_ORIGINS ?? "")
    .split(",")
    .map(value => value.trim().replace(/\/+$/, ""))
    .filter(Boolean);
}

function corsHeaders(origin, allowed) {
  const headers = { Vary: "Origin" };
  if (allowed.length === 0) headers["Access-Control-Allow-Origin"] = "*";
  else if (origin && allowed.includes(origin)) headers["Access-Control-Allow-Origin"] = origin;
  headers["Access-Control-Allow-Methods"] = "GET, OPTIONS";
  headers["Access-Control-Allow-Headers"] = "Accept, Content-Type";
  headers["Access-Control-Max-Age"] = "86400";
  return headers;
}

function respond(status, body, cors) {
  return new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: { ...JSON_HEADERS, ...cors }
  });
}

async function importDeck(sourceUrl) {
  const provider = providerFor(sourceUrl);
  if (!provider) {
    return {
      status: 400,
      error: "Dieser Anbieter wird beim URL-Import noch nicht unterstützt. Unterstützt: Moxfield, Archidekt und Deckstats."
    };
  }

  try {
    if (provider === "moxfield") return { status: 200, data: await importMoxfield(sourceUrl) };
    if (provider === "archidekt") return { status: 200, data: await importArchidekt(sourceUrl) };
    return { status: 200, data: await importDeckstats(sourceUrl) };
  } catch (error) {
    return {
      status: 502,
      error: error instanceof Error ? error.message : "Deck konnte vom Anbieter nicht geladen werden."
    };
  }
}

export default {
  async fetch(request, env) {
    const allowed = allowedOrigins(env);
    const origin = request.headers.get("Origin") || "";
    const cors = corsHeaders(origin, allowed);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }
    if (request.method !== "GET") {
      return respond(405, { error: "Nur GET wird unterstützt." }, cors);
    }
    // Browser senden immer einen Origin-Header. Fremde Webseiten werden abgewiesen;
    // Aufrufe ohne Origin (Adresszeile, curl) bleiben zum Testen möglich.
    if (allowed.length > 0 && origin && !allowed.includes(origin)) {
      return respond(403, { error: "Diese Webseite darf den Import-Dienst nicht nutzen." }, cors);
    }

    const requestUrl = new URL(request.url);
    const value = clean(requestUrl.searchParams.get("url"));
    if (!value) return respond(400, { error: "Deck-URL fehlt." }, cors);

    let sourceUrl;
    try {
      sourceUrl = new URL(value);
    } catch {
      return respond(400, { error: "Ungültige Deck-URL." }, cors);
    }
    if (sourceUrl.protocol !== "https:") {
      return respond(400, { error: "Nur HTTPS-URLs werden unterstützt." }, cors);
    }

    const result = await importDeck(sourceUrl);
    return result.data
      ? respond(200, result.data, cors)
      : respond(result.status, { error: result.error }, cors);
  }
};

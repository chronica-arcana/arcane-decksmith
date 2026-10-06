// Arcane Decksmith – KI-Worker (Deckanalyse über Groq + Deck-Intelligence)
//
// Eine einzelne Datei, die sich direkt in den Cloudflare-Editor einfügen lässt.
// Anmeldung: Supabase-Access-Token (JWT). Der Block "supabase-auth" ist eine Kopie von
// worker/supabase-auth.js (ein Test stellt sicher, dass beide identisch bleiben).
//
// Variablen/Secrets (Cloudflare → Worker → Settings → Variables and secrets):
//   ALLOWED_ORIGINS      Text    erlaubte Seiten, kommagetrennt, ohne Pfad
//                                z. B. https://arcane-decksmith.vercel.app,http://localhost:5173
//   SUPABASE_URL         Text    z. B. https://abcdxyz.supabase.co
//   SUPABASE_JWT_SECRET  Secret  nur bei altem HS256-Projekt (Legacy JWT Secret)
//   GROQ_API_KEY         Secret  (unverändert)
//   TOPDECK_API_KEY      Secret  (unverändert)

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_MODEL = "openai/gpt-oss-20b";
const MAX_ANALYSIS_LENGTH = 12000;
const MAX_CARD_MAP_ENTRIES = 240;
const MAX_CARD_NAME_LENGTH = 200;
const MAX_GROQ_ATTEMPTS = 2;

const REQUIRED_HEADINGS = [
  "### Kurzfazit",
  "### Mana-Kurve und Länder",
  "### Kartenrollen und Synergien",
  "### Interaktion und Kartennachschub",
  "### Stärken",
  "### Schwächen",
  "### Spielweise",
  "### Mulligan und frühe Züge",
  "### Fazit"
];

const TOKEN_PATTERN = /\[\[(?:C|D|P|E)\d{3}\]\]/g;
const TOKEN_KEY_PATTERN = /^\[\[(?:C|D|P|E)\d{3}\]\]$/;
const PURCHASE_SELECTION_PREFIX = "PURCHASE_SELECTION:";

/** Erlaubte Seiten aus der Variable ALLOWED_ORIGINS (kommagetrennt, ohne Slash am Ende). */
function allowedOrigins(env) {
  return String(env?.ALLOWED_ORIGINS ?? "")
    .split(",")
    .map(value => value.trim().replace(/\/+$/, ""))
    .filter(Boolean);
}

function corsHeaders(origin, env) {
  const headers = {
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Cache-Control": "no-store"
  };

  if (origin && allowedOrigins(env).includes(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers.Vary = "Origin";
  }

  return headers;
}

function jsonResponse(data, status, origin, env) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...corsHeaders(origin, env)
    }
  });
}

// ---- BEGIN supabase-auth (Kopie von worker/supabase-auth.js) ----
const JWKS_TTL_MS = 10 * 60 * 1000;
const jwksCache = new Map(); // url -> { keys, expiresAt }

class AuthError extends Error {
  constructor(message, status = 401) {
    super(message);
    this.name = "AuthError";
    this.status = status;
  }
}

function base64UrlToBytes(value) {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function decodeJson(part) {
  try {
    return JSON.parse(new TextDecoder().decode(base64UrlToBytes(part)));
  } catch {
    throw new AuthError("Ungültiges Token.");
  }
}

async function loadJwks(supabaseUrl, fetchImpl, forceRefresh) {
  const url = `${supabaseUrl}/auth/v1/.well-known/jwks.json`;
  const cached = jwksCache.get(url);
  if (!forceRefresh && cached && cached.expiresAt > Date.now()) return cached.keys;
  const response = await fetchImpl(url);
  if (!response.ok) throw new AuthError("Schlüssel zur Token-Prüfung nicht verfügbar.", 503);
  const body = await response.json();
  const keys = Array.isArray(body?.keys) ? body.keys : [];
  jwksCache.set(url, { keys, expiresAt: Date.now() + JWKS_TTL_MS });
  return keys;
}

async function verifySignature(header, signingInput, signature, env, fetchImpl) {
  const data = new TextEncoder().encode(signingInput);

  if (header.alg === "HS256") {
    if (!env.SUPABASE_JWT_SECRET) throw new AuthError("Token-Prüfung nicht konfiguriert.", 500);
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(env.SUPABASE_JWT_SECRET),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"]
    );
    return crypto.subtle.verify("HMAC", key, signature, data);
  }

  const algorithms = {
    ES256: { import: { name: "ECDSA", namedCurve: "P-256" }, verify: { name: "ECDSA", hash: "SHA-256" } },
    RS256: { import: { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, verify: { name: "RSASSA-PKCS1-v1_5" } }
  };
  const algorithm = algorithms[header.alg];
  if (!algorithm) throw new AuthError("Nicht unterstütztes Token-Verfahren.");

  const find = async (refresh) => {
    const keys = await loadJwks(env.SUPABASE_URL, fetchImpl, refresh);
    return keys.find((k) => k.kid === header.kid && (!k.alg || k.alg === header.alg));
  };
  // Nach einem Schlüsselwechsel einmal neu laden, bevor das Token abgelehnt wird.
  const jwk = (await find(false)) ?? (await find(true));
  if (!jwk) throw new AuthError("Unbekannter Schlüssel.");

  const key = await crypto.subtle.importKey("jwk", jwk, algorithm.import, false, ["verify"]);
  return crypto.subtle.verify(algorithm.verify, key, signature, data);
}

/** Prüft Signatur, Aussteller, Zielgruppe und Ablauf; liefert die Token-Claims. */
async function verifySupabaseJwt(token, env, fetchImpl = fetch) {
  if (!env?.SUPABASE_URL) throw new AuthError("Token-Prüfung nicht konfiguriert.", 500);
  const supabaseUrl = String(env.SUPABASE_URL).replace(/\/+$/, "");

  const parts = String(token ?? "").split(".");
  if (parts.length !== 3) throw new AuthError("Ungültiges Token.");
  const [headerPart, payloadPart, signaturePart] = parts;

  const header = decodeJson(headerPart);
  const payload = decodeJson(payloadPart);
  if (!header || typeof header !== "object" || !payload || typeof payload !== "object") {
    throw new AuthError("Ungültiges Token.");
  }

  const valid = await verifySignature(
    header,
    `${headerPart}.${payloadPart}`,
    base64UrlToBytes(signaturePart),
    { ...env, SUPABASE_URL: supabaseUrl },
    fetchImpl
  );
  if (!valid) throw new AuthError("Token-Signatur ungültig.");

  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== "number" || payload.exp <= now) throw new AuthError("Token abgelaufen.");
  if (payload.iss !== `${supabaseUrl}/auth/v1`) throw new AuthError("Token stammt von einem anderen Projekt.");
  const audience = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!audience.includes("authenticated")) throw new AuthError("Token ist nicht für angemeldete Nutzer.");
  if (typeof payload.sub !== "string" || !payload.sub) throw new AuthError("Token ohne Nutzerkennung.");

  return payload;
}

/** Liest `Authorization: Bearer …` aus der Anfrage und prüft das Token. */
async function authenticate(request, env, fetchImpl = fetch) {
  const header = request.headers.get("Authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (!match) throw new AuthError("Anmeldung erforderlich.");
  const claims = await verifySupabaseJwt(match[1].trim(), env, fetchImpl);
  return { userId: claims.sub, email: typeof claims.email === "string" ? claims.email : null, claims };
}
// ---- END supabase-auth ----

function isPlainObject(value) {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}

function validateCardMap(value) {
  if (!isPlainObject(value)) {
    throw new Error("Karten-Zuordnung fehlt oder ist ungültig.");
  }

  const entries = Object.entries(value);

  if (entries.length === 0 || entries.length > MAX_CARD_MAP_ENTRIES) {
    throw new Error("Karten-Zuordnung hat eine ungültige Größe.");
  }

  const result = {};

  for (const [token, name] of entries) {
    if (!TOKEN_KEY_PATTERN.test(token)) {
      throw new Error(`Ungültige Kartenkennung: ${token}`);
    }

    if (
      typeof name !== "string" ||
      !name.trim() ||
      name.length > MAX_CARD_NAME_LENGTH ||
      /[\r\n]/.test(name)
    ) {
      throw new Error(`Ungültiger Kartenname für ${token}.`);
    }

    result[token] = name.trim();
  }

  return result;
}

function validateAnalysisTokens(analysis, cardMap) {
  const tokens = new Set(analysis.match(TOKEN_PATTERN) ?? []);

  for (const token of tokens) {
    if (!Object.prototype.hasOwnProperty.call(cardMap, token)) {
      throw new Error(
        `Deckdaten enthalten unbekannte Kartenkennung ${token}.`
      );
    }
  }

  for (const token of Object.keys(cardMap)) {
    if (!analysis.includes(token)) {
      throw new Error(
        `Kartenkennung ${token} fehlt in den autoritativen Deckdaten.`
      );
    }
  }
}

function tokenKind(token) {
  return token.slice(2, 3);
}

function buildInstructions() {
  return [
    "Du bist der Deckanalyse-Assistent von Arcane Decksmith.",
    "Antworte ausschließlich auf Deutsch.",
    "Analysiere ausschließlich das bereits fertig gebaute Deck anhand der gelieferten Daten.",
    "Der Deck Builder hat die Kartenauswahl aus der vorhandenen Sammlung bereits abgeschlossen. Du optimierst die vorhandene Sammlung NICHT nachträglich neu.",
    "",
    "SEHR WICHTIGES KENNUNGSSYSTEM:",
    "- [[Cxxx]] steht für einen tatsächlichen Commander.",
    "- [[Dxxx]] steht für eine tatsächliche Karte des fertigen Hauptdecks.",
    "- [[Pxxx]] steht ausschließlich für einen Scryfall-verifizierten optionalen Anschaffungskandidaten und gehört NICHT zum fertigen Deck.",
    "- Die Kennungen sind absichtlich undurchsichtige Platzhalter. Versuche niemals, aus einer Kennung einen Kartennamen zu erraten.",
    "- Verwende in der Analyse niemals einen ausgeschriebenen konkreten Kartennamen. Konkrete Kartenreferenzen erfolgen ausschließlich über vorhandene C-, D- oder E-Kennungen.",
    "- Erfinde niemals zusätzliche Kennungen.",
    "- P-Kennungen dürfen NICHT im Analyse-Fließtext vorkommen.",
    "- [[Exxx]] steht für eine durch externe Deckdaten verifizierte Evidenz-Kartenreferenz aus TopDeck, EDHREC, Archidekt oder Commander Spellbook.",
    "- E-Kennungen dienen ausschließlich als Evidenz für Analyse und Bewertung und sind nicht automatisch Bestandteil des Decks.",
    "- Verwende E-Kennungen nur, wenn die gelieferten Daten die jeweilige Aussage tatsächlich unterstützen.",
    "- TopDeck-Daten sind beobachtete Turnier-Korrelationen. Behaupte niemals, eine einzelne Karte verursache eine bestimmte Winrate.",
    "- EDHREC-Inclusion und EDHREC-Synergy sind Commander-Community-Signale und keine Winrates.",
    "- Archidekt-Häufigkeiten beschreiben Deckbau-Praxis und sind kein Erfolgsnachweis.",
    "- Commander-Spellbook-Combos sind kuratierte Combo-Linien; nenne eine Combo nur, wenn sie in den gelieferten Evidenzdaten enthalten ist.",
    "- Wenn eine externe Quelle als nicht verfügbar markiert ist, ziehe daraus keinerlei Schlussfolgerung.",
    "",
    "FAKTENREGELN:",
    "- Erfinde keine Karteneffekte, Werte, Rollen, Synergien oder Deckbestandteile.",
    "- Einen konkreten Karteneffekt darfst du nur beschreiben, wenn für genau diese Kennung ein Oracle-Text in den gelieferten Daten vorhanden ist.",
    "- Fehlt für eine Kennung Oracle-Text, darfst du nur gelieferte Rolle, Mana Value, Typ und Builder-Grund verwenden.",
    "- Formuliere Regeln und Effekte konservativ. Ziehe keine weitergehende Schlussfolgerung, die nicht direkt aus dem Oracle-Text folgt.",
    "- Hexproof bedeutet insbesondere nicht 'gegen alle Zauber unverwundbar'. Beschreibe Schutzmechaniken nur so weit, wie der Oracle-Text sie tatsächlich trägt.",
    "- Wenn ein Effekt einem Gegner oder dem Controller eines gegnerischen Objekts einen Vorteil gibt, stelle diesen nicht als Vorteil für den Deckspieler dar.",
    "- Wenn Informationen fehlen, sage das klar statt Modellwissen oder allgemeine Kartenkenntnis hinzuzuerfinden.",
    "- Verwende Magic-Farben nur als Weiß, Blau, Schwarz, Rot, Grün oder Farblos. Gelb ist keine Magic-Farbe.",
    "- Verwende übliche MTG-Begriffe wie Removal, Exilieren, Ramp, Kartenvorteil und Manabasis.",
    "- Nenne keine fremden Beispielkarten und keine 'ähnlich wie'-Karten.",
    "",
    "DECKANALYSE:",
    "- Die Zeile 'Deterministische Kurvenbewertung' in den technischen Deckdaten ist autoritativ. Widersprich ihr nicht.",
    "- Ist dort ausdrücklich festgehalten, dass die Mana-Value-Abweichung gering ist, darf diese Abweichung NICHT als Schwäche dargestellt werden.",
    "- Beurteile Länderzahl, Kurve, Rollen und Deckstruktur nur anhand der gelieferten Zahlen und Daten.",
    "- Erfinde keine universellen Sollwerte, die nicht in den Daten stehen.",
    "- Erkläre Commander-Synergien nur, wenn sie aus geliefertem Oracle-Text und gelieferten Deckdaten nachvollziehbar sind.",
    "- Bezeichne fehlenden Lifegain, fehlende Counterspells oder eine andere nicht vorgegebene Funktion nicht automatisch als Schwäche.",
    "- Eine Schwäche muss sich aus den gelieferten Rollen, Zielwerten, Kurvendaten, Kartentypen oder Oracle-Texten begründen lassen.",
    "- Stärken und Schwächen dürfen klar benannt werden, aber nicht mit nachträglichen Tauschempfehlungen aus der vorhandenen Sammlung vermischt werden.",
    "- Spielweise und Mulligan-Hinweise müssen aus den gelieferten Rollen, Kurven- und Oracle-Daten herleitbar sein.",
    "",
    "OPTIONALE ANSCHAFFUNGEN:",
    "- Formuliere KEINEN sichtbaren Abschnitt 'Optionale Anschaffungen'. Dieser Abschnitt wird von Arcane Decksmith deterministisch erzeugt.",
    "- Wähle lediglich bis zu drei P-Kennungen aus der verifizierten Kandidatenliste aus.",
    "- Priorisiere Kandidaten für Rollen mit positivem Defizit.",
    "- Wähle nur Kandidaten, deren gelieferter Oracle-Text einen nachvollziehbaren funktionalen Beitrag zur zugeordneten Kategorie zeigt.",
    "- Wenn kein Kandidat einen ausreichend klaren Mehrwert hat, wähle keinen.",
    "- Formuliere keine Kaufbegründung, keinen Effekttext und keinen Ersatzvorschlag für P-Kennungen. Das übernimmt die Anwendung deterministisch.",
    "",
    "AUSGABEFORMAT:",
    "- Verwende keine Markdown-Tabellen.",
    "- Verwende keine Codeblöcke.",
    "- Verwende genau die folgenden Überschriften, genau einmal und in genau dieser Reihenfolge:",
    "### Kurzfazit",
    "### Mana-Kurve und Länder",
    "### Kartenrollen und Synergien",
    "### Interaktion und Kartennachschub",
    "### Stärken",
    "### Schwächen",
    "### Spielweise",
    "### Mulligan und frühe Züge",
    "### Fazit",
    "",
    "- Direkt NACH dem vollständigen Fazit folgt genau eine zusätzliche Maschinenzeile.",
    "- Diese Maschinenzeile lautet entweder exakt 'PURCHASE_SELECTION: NONE' oder 'PURCHASE_SELECTION: [[P001]], [[P002]]' usw.",
    "- Verwende dort höchstens drei unterschiedliche, tatsächlich vorhandene P-Kennungen.",
    "- Außer in dieser letzten Maschinenzeile darf keine P-Kennung irgendwo erscheinen.",
    "- Nach der Maschinenzeile darf nichts mehr folgen.",
    "",
    "Vor der Ausgabe prüfst du intern:",
    "1. Jede konkrete Kartenreferenz im Analyse-Text ist eine vorhandene C-,D- oder E-Kennung.",
    "2. Keine P-Kennung steht im Analyse-Text.",
    "3. Jeder konkrete Karteneffekt ist durch gelieferten Oracle-Text dieser Kennung gedeckt.",
    "4. Die deterministische Kurvenbewertung wird nicht widersprochen.",
    "5. Es gibt keine pauschale Schwäche, die nicht aus den gelieferten Daten begründet ist.",
    "6. Die letzte Zeile enthält höchstens drei gültige P-Kennungen oder NONE.",
    "7. Es wurden keine ausgeschriebenen Kartennamen oder fremden Beispielkarten erfunden."
  ].join("\n");
}

function headingsInCorrectOrder(text) {
  let previousIndex = -1;

  for (const heading of REQUIRED_HEADINGS) {
    const firstIndex = text.indexOf(heading);

    if (firstIndex < 0) {
      return `Pflichtüberschrift fehlt: ${heading}`;
    }

    if (text.indexOf(heading, firstIndex + heading.length) >= 0) {
      return `Pflichtüberschrift kommt mehrfach vor: ${heading}`;
    }

    if (firstIndex <= previousIndex) {
      return "Pflichtüberschriften stehen nicht in der vorgegebenen Reihenfolge.";
    }

    previousIndex = firstIndex;
  }

  return null;
}

function containsRawMappedName(text, cardMap) {
  const normalizedText = text.toLocaleLowerCase("en-US");

  for (const name of Object.values(cardMap)) {
    const normalizedName = name.toLocaleLowerCase("en-US");

    if (
      normalizedName.length >= 4 &&
      normalizedText.includes(normalizedName)
    ) {
      return name;
    }
  }

  return null;
}

function parseModelOutput(text, cardMap) {
  if (typeof text !== "string" || !text.trim()) {
    return {
      error: "Die KI-Antwort ist leer."
    };
  }

  const trimmed = text.trim();

  if (/```/.test(trimmed)) {
    return {
      error: "Die KI-Antwort enthält einen unerlaubten Codeblock."
    };
  }

  const lines = trimmed.split("\n");
  let selectionIndex = -1;

  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].trim().startsWith(PURCHASE_SELECTION_PREFIX)) {
      if (selectionIndex >= 0) {
        return {
          error: "Die KI-Antwort enthält mehrere PURCHASE_SELECTION-Zeilen."
        };
      }

      selectionIndex = index;
    }
  }

  if (selectionIndex < 0) {
    return {
      error: "Die PURCHASE_SELECTION-Zeile fehlt."
    };
  }

  for (let index = selectionIndex + 1; index < lines.length; index += 1) {
    if (lines[index].trim()) {
      return {
        error: "Nach der PURCHASE_SELECTION-Zeile steht noch weiterer Inhalt."
      };
    }
  }

  const analysisText = lines
    .slice(0, selectionIndex)
    .join("\n")
    .trim();

  const selectionLine = lines[selectionIndex].trim();
  const headingError = headingsInCorrectOrder(analysisText);

  if (headingError) {
    return {
      error: headingError
    };
  }

  if (/###\s+Optionale Anschaffungen/i.test(analysisText)) {
    return {
      error: "Die KI hat unerlaubt selbst einen Anschaffungsabschnitt erzeugt."
    };
  }

  const tokens = analysisText.match(TOKEN_PATTERN) ?? [];

  for (const token of tokens) {
    if (!Object.prototype.hasOwnProperty.call(cardMap, token)) {
      return {
        error: `Die KI hat eine unbekannte Kartenkennung verwendet: ${token}`
      };
    }

    if (tokenKind(token) === "P") {
      return {
        error: `Anschaffungskandidat ${token} wurde unerlaubt im Analyse-Text verwendet.`
      };
    }
  }

  const rawMappedName = containsRawMappedName(analysisText, cardMap);

  if (rawMappedName) {
    return {
      error:
        "Die KI hat einen ausgeschriebenen Kartennamen statt einer Kennung verwendet: " +
        rawMappedName
    };
  }

  const selectionValue = selectionLine
    .slice(PURCHASE_SELECTION_PREFIX.length)
    .trim();

  let selectedPurchaseTokens = [];

  if (selectionValue.toUpperCase() !== "NONE") {
    const selectedTokens = selectionValue
      .split(",")
      .map(value => value.trim())
      .filter(Boolean);

    if (selectedTokens.length === 0) {
      return {
        error: "Die PURCHASE_SELECTION-Zeile ist leer."
      };
    }

    if (selectedTokens.length > 3) {
      return {
        error: "Die KI hat mehr als drei Anschaffungskandidaten ausgewählt."
      };
    }

    const unique = new Set(selectedTokens);

    if (unique.size !== selectedTokens.length) {
      return {
        error: "Die KI hat denselben Anschaffungskandidaten mehrfach ausgewählt."
      };
    }

    for (const token of selectedTokens) {
      if (!/^\[\[P\d{3}\]\]$/.test(token)) {
        return {
          error: `Ungültige Anschaffungskennung in PURCHASE_SELECTION: ${token}`
        };
      }

      if (!Object.prototype.hasOwnProperty.call(cardMap, token)) {
        return {
          error: `Nicht verifizierte Anschaffungskennung: ${token}`
        };
      }
    }

    selectedPurchaseTokens = selectedTokens;
  }

  return {
    analysisText,
    selectedPurchaseTokens
  };
}

function restoreCardNames(text, cardMap) {
  return text.replace(
    TOKEN_PATTERN,
    token => cardMap[token] ?? token
  );
}

function validateRenderedForClient(text, cardMap) {
  if (/\[\[(?:C|D|P|E)\d{3}\]\]/.test(text)) {
    return "Die gerenderte Antwort enthält nicht aufgelöste Kartenkennungen.";
  }

  const normalizedText = text.toLocaleLowerCase("en-US");

  for (const [token, name] of Object.entries(cardMap)) {
    if (tokenKind(token) !== "P") {
      continue;
    }

    if (normalizedText.includes(name.toLocaleLowerCase("en-US"))) {
      return (
        "Ein Anschaffungskandidat wurde im Analyse-Text als ausgeschriebener Kartenname verwendet: " +
        name
      );
    }
  }

  return null;
}

async function callGroq(env, analysis, correction) {
  if (!env.GROQ_API_KEY) {
    throw new Error("GROQ_API_KEY ist im Worker nicht konfiguriert.");
  }

  const instructions = buildInstructions();

  const correctionBlock = correction
    ? [
        "",
        "KORREKTURHINWEIS ZUM VORHERIGEN VERSUCH:",
        correction,
        "Erzeuge die Antwort vollständig neu und behebe genau diesen Regelverstoß."
      ].join("\n")
    : "";

  const response = await fetch(GROQ_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.GROQ_API_KEY}`
    },
    body: JSON.stringify({
      model: GROQ_MODEL,
      temperature: 0.5,
      reasoning_effort: "low",
      include_reasoning: false,
      max_completion_tokens: 4000,
      messages: [
        {
          role: "user",
          content: [
            instructions,
            correctionBlock,
            "",
            "====================",
            "ZU ANALYSIERENDE DATEN",
            "====================",
            "",
            analysis
          ].join("\n")
        }
      ]
    })
  });

  let data;

  try {
    data = await response.json();
  } catch {
    throw new Error(
      `Groq lieferte keine gültige JSON-Antwort (${response.status}).`
    );
  }

  if (!response.ok) {
    const groqMessage = data?.error?.message;

    throw new Error(
      typeof groqMessage === "string"
        ? `Groq: ${groqMessage}`
        : `Groq-Anfrage fehlgeschlagen (${response.status}).`
    );
  }

  const explanation = data?.choices?.[0]?.message?.content;

  if (typeof explanation !== "string" || !explanation.trim()) {
    console.error("Groq returned empty content.", {
      finishReason: data?.choices?.[0]?.finish_reason,
      usage: data?.usage
    });

    return null;
  }

  return explanation.trim();
}

async function askGroq(env, analysis, cardMap) {
  let correction = "";
  let lastError = "Die KI hat keine Deckanalyse zurückgegeben.";

  for (let attempt = 0; attempt < MAX_GROQ_ATTEMPTS; attempt += 1) {
    const modelOutput = await callGroq(env, analysis, correction);

    if (!modelOutput) {
      lastError = "Groq hat keine Deckanalyse zurückgegeben.";
      correction = lastError;
      continue;
    }

    const parsed = parseModelOutput(modelOutput, cardMap);

    if (parsed.error) {
      console.warn("Groq analysis rejected by validator.", {
        attempt: attempt + 1,
        validationError: parsed.error
      });

      lastError = parsed.error;
      correction = parsed.error;
      continue;
    }

    const rendered = restoreCardNames(parsed.analysisText, cardMap);
    const renderedError = validateRenderedForClient(rendered, cardMap);

    if (renderedError) {
      console.warn("Rendered Groq analysis rejected by validator.", {
        attempt: attempt + 1,
        renderedError
      });

      lastError = renderedError;
      correction = renderedError;
      continue;
    }

    return {
      explanation: rendered,
      selectedPurchaseTokens: parsed.selectedPurchaseTokens
    };
  }

  throw new Error(
    "Groq hat auch nach einem automatischen Korrekturversuch keine konsistente Deckanalyse geliefert. " +
      lastError
  );
}


// ============================================================
// DECK INTELLIGENCE
// TopDeck + EDHREC + Archidekt + Commander Spellbook
// ============================================================

const TOPDECK_API_URL = "https://topdeck.gg/api/v2/tournaments";
const SPELLBOOK_API_URL = "https://backend.commanderspellbook.com";
const EDHREC_API_URL = "https://json.edhrec.com/pages/commanders";
const ARCHIDEKT_API_URL = "https://archidekt.com/api";

const DI_SOURCE_TIMEOUT_MS = 10000;
const DI_TOPDECK_TIMEOUT_MS = 45000;
const DI_TOPDECK_CACHE_SECONDS = 6 * 60 * 60;
const DI_TOPDECK_ERROR_CACHE_SECONDS = 10 * 60;
const DI_EDHREC_CACHE_SECONDS = 24 * 60 * 60;
const DI_ARCHIDEKT_CACHE_SECONDS = 12 * 60 * 60;
const DI_MAX_CANDIDATES = 5000;
const DI_MAX_DECK_CARDS = 200;
const DI_MAX_COMBOS = 12;
const DI_USER_AGENT =
  "Arcane Decksmith/1.0 (deck intelligence; contact via project owner)";

function diNormalizeName(value) {
  return String(value || "").trim().toLowerCase();
}

function diCleanCardName(value) {
  return String(value || "")
    .replace(/^\s*\d+\s*[x×]?\s+/i, "")
    .replace(/\s+[x×]\s*\d+\s*$/i, "")
    .replace(/\s+\([A-Z0-9]{2,8}\)\s+\d+[A-Za-z★]*\s*$/i, "")
    .replace(/\s+\[[^\]]+\]\s*$/i, "")
    .trim();
}

function diClamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function diNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function diUnique(values, limit = 5000) {
  const seen = new Map();

  for (const value of values || []) {
    const cleaned = diCleanCardName(value);
    const key = diNormalizeName(cleaned);

    if (!key || seen.has(key)) continue;

    seen.set(key, cleaned);

    if (seen.size >= limit) break;
  }

  return [...seen.values()];
}

async function diFetch(url, options = {}, timeoutMs = DI_SOURCE_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal
    });
  } finally {
    clearTimeout(timeout);
  }
}

function diCacheRequest(namespace, key) {
  return new Request(
    `https://arcane-decksmith-cache.invalid/${namespace}/${encodeURIComponent(key)}`,
    { method: "GET" }
  );
}

async function diFetchJsonCached(url, namespace, key, ttlSeconds) {
  const cache = caches.default;
  const cacheKey = diCacheRequest(namespace, key);
  const cached = await cache.match(cacheKey);

  if (cached) {
    return cached.json();
  }

  const response = await diFetch(url, {
    headers: {
      Accept: "application/json",
      "User-Agent": DI_USER_AGENT
    }
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(
      `${namespace} ${response.status}${detail ? `: ${detail.slice(0, 300)}` : ""}`
    );
  }

  const data = await response.json();

  await cache.put(
    cacheKey,
    new Response(JSON.stringify(data), {
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": `public, max-age=${ttlSeconds}`
      }
    })
  );

  return data;
}


// ============================================================
// TOPDECK
// ============================================================

function diTopDeckCacheKey(format) {
  return diCacheRequest("topdeck", `${format}:30:16`);
}

function diTopDeckErrorKey(format) {
  return diCacheRequest("topdeck-error", format);
}

async function diStoreTopDeckError(format, message) {
  const cache = caches.default;

  await cache.put(
    diTopDeckErrorKey(format),
    new Response(
      JSON.stringify({
        message,
        at: Date.now()
      }),
      {
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": `public, max-age=${DI_TOPDECK_ERROR_CACHE_SECONDS}`
        }
      }
    )
  );
}

async function diReadTopDeckError(format) {
  const response = await caches.default.match(diTopDeckErrorKey(format));

  if (!response) return undefined;

  try {
    const data = await response.json();
    return typeof data?.message === "string" ? data.message : undefined;
  } catch {
    return undefined;
  }
}

async function diRefreshTopDeckCache(env, format) {
  if (!env.TOPDECK_API_KEY) {
    throw new Error("TOPDECK_API_KEY fehlt.");
  }

  const topDeckFormat =
    format === "standard"
      ? "Standard"
      : "EDH";

  const response = await diFetch(
    TOPDECK_API_URL,
    {
      method: "POST",
      headers: {
        Authorization: String(env.TOPDECK_API_KEY),
        "Content-Type": "application/json",
        Accept: "application/json"
      },
      body: JSON.stringify({
        game: "Magic: The Gathering",
        format: topDeckFormat,
        last: 30,
        participantMin: 16,
        columns: [
          "decklist",
          "wins",
          "draws",
          "losses",
          "winRate"
        ],
        rounds: false
      })
    },
    DI_TOPDECK_TIMEOUT_MS
  );

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(
      `TopDeck ${response.status}${detail ? `: ${detail.slice(0, 500)}` : ""}`
    );
  }

  const data = await response.json();

  await caches.default.put(
    diTopDeckCacheKey(format),
    new Response(JSON.stringify(data), {
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": `public, max-age=${DI_TOPDECK_CACHE_SECONDS}`
      }
    })
  );

  return data;
}

async function diGetTopDeckData(env, format, ctx) {
  if (!env.TOPDECK_API_KEY) {
    return {
      state: "missing_key",
      data: null,
      debug: "TOPDECK_API_KEY fehlt."
    };
  }

  const cached = await caches.default.match(diTopDeckCacheKey(format));

  if (cached) {
    return {
      state: "cached",
      data: await cached.json()
    };
  }

  const previousError = await diReadTopDeckError(format);

  const refresh = diRefreshTopDeckCache(env, format)
    .catch(async error => {
      const message =
        error instanceof Error
          ? error.message
          : String(error);

      console.error("TopDeck background refresh failed:", error);

      await diStoreTopDeckError(format, message).catch(() => {});
    });

  if (ctx?.waitUntil) {
    ctx.waitUntil(refresh);

    return {
      state: "warming",
      data: null,
      debug:
        previousError ||
        "TopDeck-Cache wird im Hintergrund aufgebaut. Beim nächsten Aufruf werden Cache-Daten verwendet."
    };
  }

  await refresh;

  const warmed = await caches.default.match(diTopDeckCacheKey(format));

  return warmed
    ? {
        state: "cached",
        data: await warmed.json()
      }
    : {
        state: "unavailable",
        data: null,
        debug:
          (await diReadTopDeckError(format)) ||
          "TopDeck konnte nicht geladen werden."
      };
}

function diCardMapFromSection(section) {
  const result = new Map();

  if (!section) return result;

  if (Array.isArray(section)) {
    for (const item of section) {
      if (typeof item === "string") {
        const name = diCleanCardName(item);
        if (name) result.set(diNormalizeName(name), name);
        continue;
      }

      if (item && typeof item === "object") {
        const name = diCleanCardName(
          item.name || item.card || item.cardName || ""
        );

        if (name) result.set(diNormalizeName(name), name);
      }
    }

    return result;
  }

  if (typeof section !== "object") return result;

  for (const [key, value] of Object.entries(section)) {
    const keyName = diCleanCardName(key);

    if (
      keyName &&
      (
        typeof value === "number" ||
        typeof value === "string" ||
        value === null ||
        (value && typeof value === "object" && (
          "quantity" in value ||
          "count" in value ||
          "qty" in value
        ))
      )
    ) {
      result.set(diNormalizeName(keyName), keyName);
      continue;
    }

    if (value && typeof value === "object") {
      for (const [nestedKey, nestedName] of diCardMapFromSection(value)) {
        result.set(nestedKey, nestedName);
      }
    }
  }

  return result;
}

function diParseTopDeckObject(deckObj) {
  const cards = new Map();
  const commanders = new Map();

  if (!deckObj || typeof deckObj !== "object") {
    return { cards, commanders };
  }

  for (const [sectionName, section] of Object.entries(deckObj)) {
    const lower = sectionName.toLowerCase();
    const sectionCards = diCardMapFromSection(section);

    if (/commander|leader/.test(lower)) {
      for (const [key, name] of sectionCards) {
        commanders.set(key, name);
        cards.set(key, name);
      }

      continue;
    }

    if (/main|deck|card|sideboard|companion/.test(lower)) {
      for (const [key, name] of sectionCards) {
        cards.set(key, name);
      }
    }
  }

  if (cards.size === 0) {
    for (const [key, name] of diCardMapFromSection(deckObj)) {
      cards.set(key, name);
    }
  }

  return { cards, commanders };
}

function diParseTopDeckText(text) {
  const cards = new Map();
  const commanders = new Map();

  if (
    typeof text !== "string" ||
    /^https?:\/\//i.test(text.trim())
  ) {
    return { cards, commanders };
  }

  let section = "main";

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();

    if (!line) continue;

    const heading = line
      .replace(/^[~#/*\-\s]+|[~#/*\-\s]+$/g, "")
      .toLowerCase();

    if (/commanders?|leaders?/.test(heading) && !/^\d/.test(line)) {
      section = "commander";
      continue;
    }

    if (/main(board)?|deck/.test(heading) && !/^\d/.test(line)) {
      section = "main";
      continue;
    }

    if (/sideboard|maybeboard/.test(heading) && !/^\d/.test(line)) {
      section = "side";
      continue;
    }

    if (section === "side") continue;

    const name = diCleanCardName(line);

    if (!name || name.length < 2) continue;

    const key = diNormalizeName(name);
    cards.set(key, name);

    if (section === "commander") {
      commanders.set(key, name);
    }
  }

  return { cards, commanders };
}

function diParseTopDeckStanding(standing) {
  const fromObject = diParseTopDeckObject(standing?.deckObj);

  if (fromObject.cards.size > 0) {
    return fromObject;
  }

  return diParseTopDeckText(standing?.decklist);
}

function diTopDeckStandingResult(standing) {
  const wins = Math.max(0, diNumber(standing?.wins) || 0);
  const draws = Math.max(0, diNumber(standing?.draws) || 0);
  const losses = Math.max(0, diNumber(standing?.losses) || 0);
  const games = wins + draws + losses;

  if (games > 0) {
    return {
      games,
      points: wins + draws * 0.5
    };
  }

  const winRate = diNumber(standing?.winRate);

  if (winRate !== undefined) {
    return {
      games: 4,
      points: diClamp(winRate, 0, 1) * 4
    };
  }

  return null;
}

function diPerformanceSignal(stats, baseline, format, priorGames = 10) {
  if (!stats || stats.games <= 0 || stats.decks <= 0) {
    return 0;
  }

  const smoothed =
    (stats.points + baseline * priorGames) /
    (stats.games + priorGames);

  const scale =
    format === "standard"
      ? 0.09
      : 0.075;

  const confidence = Math.min(
    1,
    Math.sqrt(stats.decks / 8) *
      Math.sqrt(stats.games / 32)
  );

  return diClamp(
    Math.tanh((smoothed - baseline) / scale) * confidence,
    -1,
    1
  );
}

function diAnalyzeTopDeck(data, format, targetNames, commanderNames) {
  const tournaments = Array.isArray(data)
    ? data
    : Array.isArray(data?.data)
      ? data.data
      : [];

  const targetMap = new Map(
    targetNames.map(name => [diNormalizeName(name), name])
  );

  const commanderSet = new Set(
    commanderNames.map(diNormalizeName)
  );

  const decks = [];
  let totalPoints = 0;
  let totalGames = 0;

  for (const tournament of tournaments) {
    const standings = Array.isArray(tournament?.standings)
      ? tournament.standings
      : [];

    for (const standing of standings) {
      const result = diTopDeckStandingResult(standing);

      if (!result) continue;

      const parsed = diParseTopDeckStanding(standing);

      if (parsed.cards.size === 0) continue;

      const commanderMatch =
        commanderSet.size > 0 &&
        [...commanderSet].every(key => parsed.commanders.has(key));

      decks.push({
        result,
        cards: parsed.cards,
        commanderMatch
      });

      totalPoints += result.points;
      totalGames += result.games;
    }
  }

  if (decks.length === 0 || totalGames === 0) {
    return {
      available: false,
      cards: [],
      cardSignals: {},
      sampleDecks: 0,
      sampleGames: 0
    };
  }

  const baseline = totalPoints / totalGames;
  const generic = new Map();
  const commanderSpecific = new Map();

  const addStats = (map, key, result) => {
    const current = map.get(key) || {
      decks: 0,
      games: 0,
      points: 0
    };

    current.decks += 1;
    current.games += result.games;
    current.points += result.points;

    map.set(key, current);
  };

  for (const deck of decks) {
    for (const key of deck.cards.keys()) {
      if (!targetMap.has(key)) continue;

      addStats(generic, key, deck.result);

      if (deck.commanderMatch) {
        addStats(commanderSpecific, key, deck.result);
      }
    }
  }

  const cards = [];
  const cardSignals = {};

  for (const [key, displayName] of targetMap) {
    const stats = generic.get(key);

    if (!stats) continue;

    const performance =
      diPerformanceSignal(
        stats,
        baseline,
        format,
        10
      );

    const commanderStats = commanderSpecific.get(key);

    const commanderPerformance =
      commanderStats &&
      commanderStats.decks >= 2 &&
      commanderStats.games >= 6
        ? diPerformanceSignal(
            commanderStats,
            baseline,
            format,
            7
          )
        : undefined;

    const smoothedWinRate =
      (stats.points + baseline * 10) /
      (stats.games + 10);

    cards.push({
      name: displayName,
      winRate: smoothedWinRate,
      baselineWinRate: baseline,
      sampleDecks: stats.decks,
      sampleGames: stats.games,
      performance,
      commanderPerformance
    });

    cardSignals[key] = {
      performance,
      commanderPerformance,
      sampleDecks: stats.decks,
      sampleGames: stats.games
    };
  }

  cards.sort((a, b) =>
    Math.max(
      b.commanderPerformance ?? -2,
      b.performance ?? -2
    ) -
    Math.max(
      a.commanderPerformance ?? -2,
      a.performance ?? -2
    )
  );

  return {
    available: true,
    format: format === "standard" ? "Standard" : "EDH",
    baselineWinRate: baseline,
    sampleDecks: decks.length,
    sampleGames: totalGames,
    cards,
    cardSignals
  };
}

async function diTopDeckIntelligence(env, format, targetNames, commanders, ctx) {
  const loaded = await diGetTopDeckData(env, format, ctx);

  if (!loaded.data) {
    return {
      data: {
        available: false,
        cards: [],
        cacheState: loaded.state,
        debug: loaded.debug
      },
      signals: {}
    };
  }

  const result = diAnalyzeTopDeck(
    loaded.data,
    format,
    targetNames,
    commanders
  );

  const signals = result.cardSignals || {};
  delete result.cardSignals;

  result.cacheState = loaded.state;

  return {
    data: result,
    signals
  };
}


// ============================================================
// COMMANDER SPELLBOOK
// ============================================================

function diSpellbookBody(commanders, deckCards) {
  const counts = new Map();

  for (const card of deckCards) {
    const key = diNormalizeName(card);
    const current = counts.get(key) || {
      card,
      quantity: 0
    };

    current.quantity += 1;
    counts.set(key, current);
  }

  return {
    commanders: commanders.map(card => ({
      card,
      quantity: 1
    })),
    main: [...counts.values()]
  };
}

function diSpellbookVariants(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.results)) return value.results;
  if (Array.isArray(value?.variants)) return value.variants;
  return [];
}

function diSpellbookCardNames(variant) {
  const names = [];

  for (const use of variant?.uses || []) {
    const name = diCleanCardName(use?.card?.name || "");
    if (name) names.push(name);
  }

  return diUnique(names, 20);
}

function diSpellbookResults(variant) {
  const results = [];

  for (const produced of variant?.produces || []) {
    const name = String(produced?.feature?.name || "").trim();
    if (name) results.push(name);
  }

  return diUnique(results, 20);
}

async function diSpellbookIntelligence(commanders, deckCards, candidateCards) {
  if (!commanders.length || !deckCards.length) {
    return {
      data: {
        available: false,
        includedCombos: [],
        almostCombos: []
      },
      signals: {}
    };
  }

  const response = await diFetch(
    `${SPELLBOOK_API_URL}/find-my-combos`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "User-Agent": DI_USER_AGENT
      },
      body: JSON.stringify(
        diSpellbookBody(commanders, deckCards)
      )
    }
  );

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(
      `Commander Spellbook ${response.status}${detail ? `: ${detail.slice(0, 300)}` : ""}`
    );
  }

  const raw = await response.json();

  const root =
    raw?.results &&
    typeof raw.results === "object" &&
    !Array.isArray(raw.results)
      ? raw.results
      : raw;

  const includedRaw =
    diSpellbookVariants(root?.included);

  const almostRaw =
    diSpellbookVariants(
      root?.almostIncluded ??
      root?.almost_included
    );

  const deckSet = new Set(
    deckCards.map(diNormalizeName)
  );

  const candidateSet = new Set(
    candidateCards.map(diNormalizeName)
  );

  function summarize(variant) {
    const cards = diSpellbookCardNames(variant);
    const missingCards = cards.filter(
      card => !deckSet.has(diNormalizeName(card))
    );

    return {
      id: String(
        variant?.id ??
        variant?.variant_id ??
        ""
      ),
      cards,
      missingCards,
      results: diSpellbookResults(variant),
      popularity: diNumber(variant?.popularity),
      score:
        missingCards.length === 0
          ? 1
          : missingCards.length === 1
            ? 0.8
            : 0.4
    };
  }

  const includedCombos =
    includedRaw
      .map(summarize)
      .slice(0, DI_MAX_COMBOS);

  const almostCombos =
    almostRaw
      .map(summarize)
      .filter(combo => {
        if (combo.missingCards.length !== 1) {
          return false;
        }

        return candidateSet.has(
          diNormalizeName(combo.missingCards[0])
        );
      })
      .slice(0, DI_MAX_COMBOS);

  const signals = {};

  const setSignal = (name, value) => {
    const key = diNormalizeName(name);

    if (!key) return;

    signals[key] = Math.max(
      signals[key] || 0,
      diClamp(value, 0, 1)
    );
  };

  for (const combo of includedCombos) {
    for (const card of combo.cards) {
      setSignal(card, 0.8);
    }
  }

  for (const combo of almostCombos) {
    setSignal(combo.missingCards[0], 1);

    for (const existing of combo.cards) {
      if (!combo.missingCards.includes(existing)) {
        setSignal(existing, 0.55);
      }
    }
  }

  return {
    data: {
      available:
        includedCombos.length > 0 ||
        almostCombos.length > 0,
      includedCombos,
      almostCombos
    },
    signals
  };
}


// ============================================================
// EDHREC
// ============================================================

function diCommanderSlug(name) {
  return String(name || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/\/\/.+$/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function diCollectEdhrecCards(
  value,
  targetMap,
  result,
  visited = new Set()
) {
  if (
    !value ||
    typeof value !== "object" ||
    visited.has(value)
  ) {
    return;
  }

  visited.add(value);

  if (Array.isArray(value)) {
    for (const item of value) {
      diCollectEdhrecCards(
        item,
        targetMap,
        result,
        visited
      );
    }

    return;
  }

  const name =
    typeof value.name === "string"
      ? value.name
      : typeof value.card === "string"
        ? value.card
        : undefined;

  if (name) {
    const key = diNormalizeName(name);

    if (targetMap.has(key)) {
      const synergyRaw = diNumber(value.synergy);

      const synergy =
        synergyRaw === undefined
          ? undefined
          : Math.abs(synergyRaw) > 1
            ? synergyRaw / 100
            : synergyRaw;

      const numDecks =
        diNumber(
          value.num_decks ??
          value.numDecks
        );

      const potentialDecks =
        diNumber(
          value.potential_decks ??
          value.potentialDecks
        );

      const inclusionRate =
        numDecks !== undefined &&
        potentialDecks
          ? diClamp(
              numDecks / potentialDecks,
              0,
              1
            )
          : undefined;

      const score = diClamp(
        (synergy || 0) * 0.8 +
        (inclusionRate || 0) * 0.2,
        -1,
        1
      );

      const old = result.get(key);

      if (
        !old ||
        Math.abs(score) >
          Math.abs(old.score || 0)
      ) {
        result.set(key, {
          name: targetMap.get(key),
          synergy,
          inclusionRate,
          numDecks,
          potentialDecks,
          score
        });
      }
    }
  }

  for (const child of Object.values(value)) {
    diCollectEdhrecCards(
      child,
      targetMap,
      result,
      visited
    );
  }
}

async function diEdhrecIntelligence(commanders, targetNames) {
  if (!commanders.length) {
    return {
      data: {
        available: false,
        cards: []
      },
      signals: {}
    };
  }

  const slugs = commanders
    .map(diCommanderSlug)
    .filter(Boolean);

  const candidates =
    slugs.length <= 1
      ? slugs
      : [
          slugs.join("-"),
          [...slugs].reverse().join("-")
        ];

  let raw;
  let lastError;

  for (const slug of candidates) {
    try {
      raw = await diFetchJsonCached(
        `${EDHREC_API_URL}/${encodeURIComponent(slug)}.json`,
        "edhrec",
        slug,
        DI_EDHREC_CACHE_SECONDS
      );

      break;
    } catch (error) {
      lastError = error;
    }
  }

  if (!raw) {
    throw lastError || new Error("EDHREC nicht verfügbar.");
  }

  const targetMap = new Map(
    targetNames.map(name => [
      diNormalizeName(name),
      name
    ])
  );

  const collected = new Map();

  diCollectEdhrecCards(
    raw,
    targetMap,
    collected
  );

  const cards =
    [...collected.values()].sort(
      (a, b) =>
        (b.score || 0) -
        (a.score || 0)
    );

  const signals = {};

  for (const card of cards) {
    signals[
      diNormalizeName(card.name)
    ] = card.score || 0;
  }

  return {
    data: {
      available: cards.length > 0,
      commander: commanders.join(" + "),
      cards
    },
    signals
  };
}


// ============================================================
// ARCHIDEKT
// ============================================================

function diArchidektResults(raw) {
  if (Array.isArray(raw)) return raw;
  if (Array.isArray(raw?.results)) return raw.results;
  if (Array.isArray(raw?.data)) return raw.data;
  return [];
}

function diArchidektCardInfo(entry) {
  const oracle =
    entry?.card?.oracleCard ||
    entry?.card?.oracle_card ||
    {};

  const card = entry?.card || {};

  const name = diCleanCardName(
    oracle?.name ||
    card?.displayName ||
    card?.name ||
    entry?.name ||
    ""
  );

  const typeParts = [
    oracle?.typeLine,
    oracle?.type_line,
    oracle?.type,
    card?.typeLine,
    card?.type_line,
    card?.type,
    Array.isArray(oracle?.types)
      ? oracle.types.join(" ")
      : "",
    Array.isArray(card?.types)
      ? card.types.join(" ")
      : "",
    ...(Array.isArray(entry?.categories)
      ? entry.categories.map(category =>
          typeof category === "string"
            ? category
            : category?.name || ""
        )
      : [])
  ];

  const typeLine =
    typeParts
      .filter(Boolean)
      .join(" ");

  const manaValue =
    diNumber(
      oracle?.cmc ??
      oracle?.manaValue ??
      oracle?.mana_value ??
      card?.cmc ??
      card?.manaValue ??
      card?.mana_value
    );

  const quantity =
    Math.max(
      1,
      Math.trunc(
        diNumber(entry?.quantity ?? entry?.qty) || 1
      )
    );

  return {
    name,
    typeLine,
    manaValue,
    quantity
  };
}

function diSummarizeArchidektDeck(deck) {
  const cards = new Map();
  let lands = 0;
  let manaSum = 0;
  let manaCount = 0;
  let totalCards = 0;

  for (const entry of deck?.cards || []) {
    const info = diArchidektCardInfo(entry);

    if (!info.name) continue;

    totalCards += info.quantity;
    cards.set(diNormalizeName(info.name), info.name);

    if (/\bLand\b/i.test(info.typeLine)) {
      lands += info.quantity;
    } else if (info.manaValue !== undefined) {
      manaSum += info.manaValue * info.quantity;
      manaCount += info.quantity;
    }
  }

  return {
    cards,
    lands,
    totalCards,
    averageManaValue:
      manaCount > 0
        ? manaSum / manaCount
        : undefined
  };
}

async function diArchidektIntelligence(commanders, targetNames) {
  if (commanders.length !== 1) {
    return {
      data: {
        available: false,
        cards: []
      },
      signals: {},
      structure: undefined
    };
  }

  const commander = commanders[0];

  const listUrl =
    new URL(`${ARCHIDEKT_API_URL}/decks/v3/`);

  listUrl.searchParams.set(
    "commanderName",
    commander
  );

  listUrl.searchParams.set(
    "deckFormat",
    "3"
  );

  listUrl.searchParams.set(
    "pageSize",
    "12"
  );

  listUrl.searchParams.set(
    "page",
    "1"
  );

  listUrl.searchParams.set(
    "orderBy",
    "-viewCount"
  );

  const list = diArchidektResults(
    await diFetchJsonCached(
      listUrl.toString(),
      "archidekt-list",
      diNormalizeName(commander),
      DI_ARCHIDEKT_CACHE_SECONDS
    )
  );

  const ids =
    list
      .map(
        item =>
          item?.id ??
          item?.deckId ??
          item?.pk
      )
      .filter(Boolean)
      .slice(0, 8);

  const detailResults =
    await Promise.allSettled(
      ids.map(id =>
        diFetchJsonCached(
          `${ARCHIDEKT_API_URL}/decks/${id}/`,
          "archidekt-deck",
          String(id),
          DI_ARCHIDEKT_CACHE_SECONDS
        )
      )
    );

  const summaries = [];

  for (const result of detailResults) {
    if (result.status !== "fulfilled") continue;

    const summary =
      diSummarizeArchidektDeck(
        result.value
      );

    if (
      summary.cards.size > 0 &&
      summary.totalCards >= 90 &&
      summary.totalCards <= 110
    ) {
      summaries.push(summary);
    }

    if (summaries.length >= 6) break;
  }

  if (summaries.length < 3) {
    return {
      data: {
        available: false,
        cards: []
      },
      signals: {},
      structure: undefined
    };
  }

  const targetMap = new Map(
    targetNames.map(name => [
      diNormalizeName(name),
      name
    ])
  );

  const counts = new Map();
  let landTotal = 0;
  let manaTotal = 0;
  let manaDecks = 0;

  for (const summary of summaries) {
    landTotal += summary.lands;

    if (summary.averageManaValue !== undefined) {
      manaTotal += summary.averageManaValue;
      manaDecks += 1;
    }

    for (const key of summary.cards.keys()) {
      if (!targetMap.has(key)) continue;

      counts.set(
        key,
        (counts.get(key) || 0) + 1
      );
    }
  }

  const deckCount = summaries.length;
  const confidence =
    Math.min(
      1,
      Math.sqrt(deckCount / 12)
    );

  const cards = [];
  const signals = {};

  for (const [key, count] of counts) {
    const inclusionRate =
      count / deckCount;

    const score =
      diClamp(
        inclusionRate *
        confidence *
        0.45,
        0,
        0.45
      );

    cards.push({
      name: targetMap.get(key),
      inclusionRate,
      sampleDecks: deckCount,
      score
    });

    signals[key] = score;
  }

  cards.sort(
    (a, b) =>
      (b.score || 0) -
      (a.score || 0)
  );

  const structure = {
    lands:
      landTotal > 0
        ? landTotal / deckCount
        : undefined,
    targetManaValue:
      manaDecks > 0
        ? manaTotal / manaDecks
        : undefined,
    sampleDecks: deckCount
  };

  return {
    data: {
      available: true,
      format: "Commander",
      sampleDecks: deckCount,
      averageLands: structure.lands,
      averageManaValue:
        structure.targetManaValue,
      cards
    },
    signals,
    structure
  };
}


// ============================================================
// COMMON DECK INTELLIGENCE
// ============================================================

function diMergeSignals(
  topDeck,
  spellbook,
  edhrec,
  archidekt
) {
  const keys = new Set([
    ...Object.keys(topDeck || {}),
    ...Object.keys(spellbook || {}),
    ...Object.keys(edhrec || {}),
    ...Object.keys(archidekt || {})
  ]);

  const result = {};

  for (const key of keys) {
    result[key] = {
      ...(topDeck[key] || {}),
      combo: spellbook?.[key],
      edhrec: edhrec?.[key],
      archidekt: archidekt?.[key]
    };
  }

  return result;
}

async function diSafe(label, fn, fallback) {
  try {
    return await fn();
  } catch (error) {
    console.error(`${label} intelligence failed:`, error);

    return {
      ...fallback,
      data: {
        ...(fallback?.data || {}),
        debug:
          error instanceof Error
            ? error.message
            : String(error)
      }
    };
  }
}

async function handleDeckIntelligence(request, env, ctx) {
  let body;

  try {
    body = await request.json();
  } catch {
    return {
      status: 400,
      body: {
        error: "Ungültiger JSON-Request."
      }
    };
  }

  const format =
    body?.format === "standard"
      ? "standard"
      : "commander";

  const action =
    body?.action === "analyze"
      ? "analyze"
      : "build";

  const commanders =
    diUnique(
      body?.commanders || [],
      2
    );

  const deckCards =
    diUnique(
      body?.deckCards || [],
      DI_MAX_DECK_CARDS
    );

  const candidateCards =
    diUnique(
      body?.candidateCards || [],
      DI_MAX_CANDIDATES
    );

  const targetCards =
    action === "build"
      ? candidateCards
      : diUnique(
          [
            ...deckCards,
            ...commanders
          ],
          DI_MAX_DECK_CARDS
        );

  const [
    topDeckResult,
    spellbookResult,
    edhrecResult,
    archidektResult
  ] = await Promise.all([
    diSafe(
      "TopDeck",
      () =>
        diTopDeckIntelligence(
          env,
          format,
          targetCards,
          commanders,
          ctx
        ),
      {
        data: {
          available: false,
          cards: []
        },
        signals: {}
      }
    ),

    format === "commander"
      ? diSafe(
          "Commander Spellbook",
          () =>
            diSpellbookIntelligence(
              commanders,
              deckCards,
              candidateCards
            ),
          {
            data: {
              available: false,
              includedCombos: [],
              almostCombos: []
            },
            signals: {}
          }
        )
      : Promise.resolve({
          data: {
            available: false,
            includedCombos: [],
            almostCombos: []
          },
          signals: {}
        }),

    format === "commander"
      ? diSafe(
          "EDHREC",
          () =>
            diEdhrecIntelligence(
              commanders,
              targetCards
            ),
          {
            data: {
              available: false,
              cards: []
            },
            signals: {}
          }
        )
      : Promise.resolve({
          data: {
            available: false,
            cards: []
          },
          signals: {}
        }),

    format === "commander"
      ? diSafe(
          "Archidekt",
          () =>
            diArchidektIntelligence(
              commanders,
              targetCards
            ),
          {
            data: {
              available: false,
              cards: []
            },
            signals: {},
            structure: undefined
          }
        )
      : Promise.resolve({
          data: {
            available: false,
            cards: []
          },
          signals: {},
          structure: undefined
        })
  ]);

  return {
    status: 200,
    body: {
      topDeck:
        topDeckResult.data,

      spellbook:
        spellbookResult.data,

      edhrec:
        edhrecResult.data,

      archidekt:
        archidektResult.data,

      structure:
        archidektResult.structure,

      cardSignals:
        diMergeSignals(
          topDeckResult.signals,
          spellbookResult.signals,
          edhrecResult.signals,
          archidektResult.signals
        )
    }
  };
}


// ============================================================
// ROUTING + AUTH
// ============================================================

async function authenticateRequest(request, env) {
  const authorization =
    request.headers.get("Authorization");

  if (
    !authorization ||
    !authorization.startsWith("Bearer ")
  ) {
    return {
      ok: false,
      status: 401,
      error: "Anmeldung fehlt."
    };
  }

  const token =
    authorization
      .slice("Bearer ".length)
      .trim();

  if (!token) {
    return {
      ok: false,
      status: 401,
      error: "Anmeldung fehlt."
    };
  }

  try {
    const payload =
      await verifySupabaseJwt(token, env);

    return {
      ok: true,
      payload
    };
  } catch (error) {
    console.error(
      "Supabase token verification failed:",
      error
    );

    // 500/503 = Worker falsch konfiguriert bzw. Schlüssel nicht abrufbar; sonst 401.
    const status =
      error instanceof AuthError && error.status >= 500
        ? error.status
        : 401;

    return {
      ok: false,
      status,
      error:
        status === 401
          ? "Anmeldung konnte nicht bestätigt werden."
          : "Die Anmeldeprüfung ist im Worker nicht korrekt konfiguriert."
    };
  }
}

async function handleAiAnalysis(request, env) {
  let body;

  try {
    body = await request.json();
  } catch {
    return {
      status: 400,
      body: {
        error: "Ungültiger JSON-Request."
      }
    };
  }

  const analysis = body?.analysis;

  if (
    typeof analysis !== "string" ||
    !analysis.trim()
  ) {
    return {
      status: 400,
      body: {
        error: "Deckanalyse fehlt."
      }
    };
  }

  if (
    analysis.length >
    MAX_ANALYSIS_LENGTH
  ) {
    return {
      status: 413,
      body: {
        error:
          "Die Deckdaten sind zu groß für eine einzelne KI-Analyse."
      }
    };
  }

  let cardMap;

  try {
    cardMap =
      validateCardMap(
        body?.cardMap
      );

    validateAnalysisTokens(
      analysis,
      cardMap
    );
  } catch (error) {
    return {
      status: 400,
      body: {
        error:
          error instanceof Error
            ? error.message
            : "Die Karten-Zuordnung ist ungültig."
      }
    };
  }

  try {
    const result =
      await askGroq(
        env,
        analysis.trim(),
        cardMap
      );

    return {
      status: 200,
      body: {
        explanation:
          result.explanation,

        selectedPurchaseTokens:
          result.selectedPurchaseTokens
      }
    };
  } catch (error) {
    console.error(
      "Groq request failed:",
      error
    );

    return {
      status: 502,
      body: {
        error:
          error instanceof Error
            ? error.message
            : "Die KI-Analyse ist fehlgeschlagen."
      }
    };
  }
}

export default {
  async fetch(request, env, ctx) {
    const origin =
      request.headers.get("Origin");

    const url =
      new URL(request.url);

    const pathname =
      url.pathname.replace(/\/+$/, "") ||
      "/";

    const allowed = allowedOrigins(env);

    if (allowed.length === 0) {
      console.error("ALLOWED_ORIGINS ist nicht konfiguriert.");

      return jsonResponse(
        {
          error: "Der Worker ist nicht konfiguriert (ALLOWED_ORIGINS fehlt)."
        },
        500,
        origin,
        env
      );
    }

    if (request.method === "OPTIONS") {
      if (!origin || !allowed.includes(origin)) {
        return jsonResponse(
          {
            error: "Origin nicht erlaubt."
          },
          403,
          origin,
          env
        );
      }

      return new Response(null, {
        status: 204,
        headers: corsHeaders(origin, env)
      });
    }

    if (request.method !== "POST") {
      return jsonResponse(
        {
          error: "Nur POST-Anfragen sind erlaubt."
        },
        405,
        origin,
        env
      );
    }

    if (
      origin &&
      !allowed.includes(origin)
    ) {
      return jsonResponse(
        {
          error: "Origin nicht erlaubt."
        },
        403,
        origin,
        env
      );
    }

    const authentication =
      await authenticateRequest(request, env);

    if (!authentication.ok) {
      return jsonResponse(
        {
          error: authentication.error
        },
        authentication.status,
        origin,
        env
      );
    }

    if (pathname === "/") {
      const result =
        await handleAiAnalysis(
          request,
          env
        );

      return jsonResponse(
        result.body,
        result.status,
        origin,
        env
      );
    }

    if (
      pathname ===
      "/deck-intelligence"
    ) {
      const result =
        await handleDeckIntelligence(
          request,
          env,
          ctx
        );

      return jsonResponse(
        result.body,
        result.status,
        origin,
        env
      );
    }

    return jsonResponse(
      {
        error:
          "Endpunkt nicht gefunden."
      },
      404,
      origin,
      env
    );
  }
};

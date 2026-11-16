#!/usr/bin/env bash
# Veröffentlicht den Spiel-Worker (wird vom GitHub-Workflow "Deploy Spiel-Worker" aufgerufen).
#
# Versuch 1: installierte Wrangler-Version. Versuch 2: nach kurzer Wartezeit erneut (z. B. wenn ein
# frisch angelegter Worker für Folgeaufrufe noch nicht sichtbar ist). Versuch 3: ältere Wrangler-Version.
# Schlägt alles fehl, gibt das Skript eine Diagnose aus (ohne Token, Konto-ID oder Nutzdaten).
#
# Umgebung: CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, SUPABASE_URL, SUPABASE_ANON_KEY, ALLOWED_ORIGINS
# Nur für Tests überschreibbar: WRANGLER (Befehl), FALLBACK_WRANGLER, RETRY_WAIT, CF_API_BASE
set -uo pipefail

WORKER_NAME="${WORKER_NAME:-arcane-decksmith-game}"
WRANGLER="${WRANGLER:-npx wrangler}"
FALLBACK_WRANGLER="${FALLBACK_WRANGLER:-npx --yes wrangler@4.20.0}"
RETRY_WAIT="${RETRY_WAIT:-20}"
CF_API_BASE="${CF_API_BASE:-https://api.cloudflare.com/client/v4}"

for name in CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID SUPABASE_URL SUPABASE_ANON_KEY ALLOWED_ORIGINS; do
  if [ -z "${!name:-}" ]; then
    echo "::error::${name} fehlt (Secret bzw. Variable in den Repo-Einstellungen anlegen)."
    exit 1
  fi
done

VARS=(--var "SUPABASE_URL:${SUPABASE_URL%/}" --var "SUPABASE_ANON_KEY:${SUPABASE_ANON_KEY}" --var "ALLOWED_ORIGINS:${ALLOWED_ORIGINS}")

# Cloudflare-Abfrage; gibt nur ausgewählte Felder aus (nie Token, Konto-ID oder Namen anderer Worker).
api() {
  curl -sS --max-time 30 -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" "${CF_API_BASE}$1" 2>&1
}
summary() {
  # $1 = jq-Ausdruck; bei ungültiger Antwort einen Hinweis statt eines Absturzes ausgeben
  jq -c "$1" 2>/dev/null || echo '{"antwort":"nicht lesbar (kein JSON)"}'
}

diagnose() {
  local id="${CLOUDFLARE_ACCOUNT_ID}"
  echo
  echo "=== Diagnose (ohne Token und ohne Konto-ID) ==="
  echo "1) Token gültig?"
  api "/user/tokens/verify" | summary '{success, status: .result.status, errors: [.errors[]?.message]}'
  echo "2) Zugriff auf das Konto, Worker-Skripte lesbar? (ist '${WORKER_NAME}' dort als Skript vorhanden?)"
  api "/accounts/${id}/workers/scripts" | summary \
    '{success, errors: [.errors[]?.message], skripte_im_konto: ([.result[]?] | length), spiel_worker_vorhanden: ([.result[]?.id] | index("'"${WORKER_NAME}"'") != null)}'
  echo "3) Neue Worker-Schnittstelle (diese Abfrage schlug bei Wrangler fehl):"
  api "/accounts/${id}/workers/workers/${WORKER_NAME}" | summary '{success, errors: [.errors[]?.message]}'
  echo "4) workers.dev-Name im Konto eingerichtet?"
  api "/accounts/${id}/workers/subdomain" | summary '{success, errors: [.errors[]?.message], eingerichtet: (.result.subdomain != null)}'
  echo "=== Ende der Diagnose ==="
}

echo "Versuch 1: ${WRANGLER} deploy"
if ${WRANGLER} deploy "${VARS[@]}"; then
  ok=1
else
  echo "::warning::Versuch 1 fehlgeschlagen. Warte ${RETRY_WAIT} Sekunden und versuche es erneut."
  sleep "${RETRY_WAIT}"
  echo "Versuch 2: ${WRANGLER} deploy"
  if ${WRANGLER} deploy "${VARS[@]}"; then
    ok=1
  else
    echo "::warning::Versuch 2 fehlgeschlagen. Versuche eine ältere Wrangler-Version."
    echo "Versuch 3: ${FALLBACK_WRANGLER} deploy"
    if ${FALLBACK_WRANGLER} deploy "${VARS[@]}"; then ok=1; else ok=0; fi
  fi
fi

if [ "${ok}" != 1 ]; then
  diagnose
  echo "::error::Das Veröffentlichen ist nach 3 Versuchen fehlgeschlagen. Die Diagnose oben zeigt, was bei Cloudflare vorhanden ist."
  exit 1
fi

# Optional: altes HS256-Schlüsselgeheimnis des Supabase-Projekts als Worker-Secret setzen.
if [ -n "${SUPABASE_JWT_SECRET:-}" ]; then
  printf '%s' "${SUPABASE_JWT_SECRET}" | ${WRANGLER} secret put SUPABASE_JWT_SECRET
fi
echo "Fertig: Worker veröffentlicht."

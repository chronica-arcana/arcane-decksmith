import type { CardRecord, DeckRecord } from "../types";
import type { AppPage } from "../navigation";

const EUR_FORMATTER = new Intl.NumberFormat("de-DE", {
  style: "currency",
  currency: "EUR"
});

function formatEuro(value: number): string {
  return Number.isFinite(value)
    ? EUR_FORMATTER.format(value)
    : "kein EUR-Preis";
}

export default function HomePage({
  cards,
  decks,
  collectionValue,
  onNavigate
}: {
  cards: CardRecord[];
  decks: DeckRecord[];
  collectionValue: number;
  onNavigate: (page: AppPage) => void;
}) {
  const totalCopies =
    cards.reduce(
      (sum, card) =>
        sum + card.count,
      0
    );


  const commanderDecks =
    decks.filter(
      deck =>
        deck.format ===
        "commander"
    ).length;

  const standardDecks =
    decks.filter(
      deck =>
        deck.format ===
        "standard"
    ).length;

  const areas = [
    {
      key: "collection" as const,
      eyebrow: "SAMMLUNG",
      icon: "✦",
      title: "Deine Karten im Blick",
      text:
        "Verwalte deine Sammlung, Finishes, Preise und Stückzahlen an einem Ort.",
      cta: "Sammlung öffnen",
      meta:
        `${totalCopies} Karten · ${cards.length} Ausgaben`
    },
    {
      key: "search" as const,
      eyebrow: "KARTENSUCHE",
      icon: "⌕",
      title: "Finden. Prüfen. Hinzufügen.",
      text:
        "Durchsuche Scryfall, wähle Drucke und Finishes oder füge ganze Sets per Bulk hinzu.",
      cta: "Karten suchen",
      meta:
        "Scryfall · Bulk · Scanner"
    },
    {
      key: "builder" as const,
      eyebrow: "DECK BAUEN",
      icon: "◆",
      title: "Aus Sammlung wird Strategie",
      text:
        "Baue neue Decks aus deinen Karten und entwickle sie gezielt weiter.",
      cta: "Deck bauen",
      meta:
        "Commander · Standard"
    },
    {
      key: "decks" as const,
      eyebrow: "DECKS",
      icon: "▣",
      title: "Alle Decks an einem Ort",
      text:
        "Öffne, bearbeite und analysiere deine gespeicherten Decks – inklusive Bulk-Workflow.",
      cta: "Decks öffnen",
      meta:
        `${commanderDecks} Commander · ${standardDecks} Standard`
    },
    {
      key: "game" as const,
      eyebrow: "SPIELEN",
      icon: "⚔",
      title: "Online gegeneinander spielen",
      text:
        "Lade Freunde per Einladungscode ein und spiele mit deinen eigenen Decks – Standard oder Commander mit bis zu 4 Spielern.",
      cta: "Spiel starten",
      meta:
        "Einladungscode · Stapel · Kampf"
    }
  ];

  return (
    <section className="landing-page">
      <style>{`
        .landing-page{
          display:grid;
          gap:24px;
        }

        .landing-hero{
          position:relative;
          overflow:hidden;
          min-height:360px;
          padding:42px;
          border:1px solid var(--border-gold);
          border-radius:24px;
          background:
            radial-gradient(
              circle at 88% 18%,
              rgba(85,215,229,.18),
              transparent 26%
            ),
            radial-gradient(
              circle at 12% 8%,
              rgba(214,173,88,.18),
              transparent 28%
            ),
            linear-gradient(
              145deg,
              rgba(13,22,39,.98),
              rgba(7,12,23,.96)
            );
          box-shadow:var(--shadow-deep);
        }

        .landing-hero::after{
          content:"";
          position:absolute;
          inset:auto -80px -120px auto;
          width:360px;
          height:360px;
          border:1px solid rgba(85,215,229,.2);
          border-radius:50%;
          box-shadow:
            0 0 0 34px rgba(85,215,229,.025),
            0 0 0 70px rgba(214,173,88,.018);
          pointer-events:none;
        }

        .landing-kicker{
          margin:0 0 12px;
          color:var(--gold-bright);
          font-size:.78rem;
          font-weight:800;
          letter-spacing:.2em;
        }

        .landing-title{
          max-width:820px;
          margin:0;
          font-size:clamp(2.3rem,7vw,5.6rem);
          line-height:.94;
          letter-spacing:-.055em;
        }

        .landing-title span{
          display:block;
          margin-top:8px;
          color:var(--arcane-bright);
        }

        .landing-lead{
          max-width:720px;
          margin:22px 0 0;
          color:var(--text-soft);
          font-size:clamp(1rem,2vw,1.18rem);
          line-height:1.7;
        }

        .landing-stats{
          display:grid;
          grid-template-columns:
            repeat(4,minmax(0,1fr));
          gap:12px;
        }

        .landing-stat{
          padding:18px 20px;
          border:1px solid var(--border);
          border-radius:16px;
          background:rgba(13,22,39,.78);
          box-shadow:var(--shadow);
        }

        .landing-stat strong{
          display:block;
          color:var(--text);
          font-size:1.45rem;
        }

        .landing-stat span{
          display:block;
          margin-top:4px;
          color:var(--muted);
          font-size:.84rem;
        }

        .landing-section-head{
          display:flex;
          align-items:end;
          justify-content:space-between;
          gap:20px;
          margin-top:6px;
        }

        .landing-section-head h2{
          margin:0;
        }

        .landing-section-head p{
          max-width:560px;
          margin:0;
          color:var(--muted);
          text-align:right;
        }

        .landing-grid{
          display:grid;
          grid-template-columns:
            repeat(2,minmax(0,1fr));
          gap:16px;
        }

        .landing-card:last-child:nth-child(odd){
          grid-column:1 / -1;
        }

        .landing-card{
          position:relative;
          overflow:hidden;
          display:flex;
          flex-direction:column;
          min-height:250px;
          padding:24px;
          text-align:left;
          border:1px solid var(--border);
          border-radius:18px;
          background:
            linear-gradient(
              145deg,
              rgba(19,31,52,.92),
              rgba(10,17,30,.96)
            );
          color:var(--text);
          box-shadow:var(--shadow);
          transition:
            transform .18s ease,
            border-color .18s ease,
            box-shadow .18s ease;
        }

        .landing-card:hover{
          transform:translateY(-3px);
          border-color:var(--border-arcane);
          box-shadow:
            0 20px 46px
            rgba(0,0,0,.36);
        }

        .landing-card::before{
          content:"";
          position:absolute;
          inset:0 auto 0 0;
          width:3px;
          background:
            linear-gradient(
              var(--gold-bright),
              var(--arcane)
            );
          opacity:.75;
        }

        .landing-card-top{
          display:flex;
          align-items:center;
          justify-content:space-between;
          gap:12px;
        }

        .landing-card-icon{
          display:grid;
          place-items:center;
          width:46px;
          height:46px;
          border:1px solid var(--border-gold);
          border-radius:14px;
          background:rgba(214,173,88,.08);
          color:var(--gold-bright);
          font-size:1.3rem;
        }

        .landing-card-eyebrow{
          color:var(--arcane-bright);
          font-size:.72rem;
          font-weight:800;
          letter-spacing:.16em;
        }

        .landing-card h3{
          margin:28px 0 10px;
          font-size:1.55rem;
        }

        .landing-card p{
          margin:0;
          color:var(--text-soft);
          line-height:1.6;
        }

        .landing-card-footer{
          display:flex;
          align-items:center;
          justify-content:space-between;
          gap:14px;
          margin-top:auto;
          padding-top:24px;
        }

        .landing-card-meta{
          color:var(--muted);
          font-size:.82rem;
        }

        .landing-card-cta{
          color:var(--gold-bright);
          font-weight:800;
        }

        @media (max-width:900px){
          .landing-hero{
            min-height:0;
            padding:30px 24px;
          }

          .landing-stats{
            grid-template-columns:
              repeat(2,minmax(0,1fr));
          }

          .landing-grid{
            grid-template-columns:1fr;
          }

          .landing-section-head{
            align-items:flex-start;
            flex-direction:column;
          }

          .landing-section-head p{
            text-align:left;
          }
        }

        @media (max-width:560px){
          .landing-page{
            gap:18px;
          }

          .landing-hero{
            padding:24px 18px;
            border-radius:18px;
          }

          .landing-stats{
            grid-template-columns:1fr 1fr;
            gap:8px;
          }

          .landing-stat{
            padding:14px;
          }

          .landing-card{
            min-height:230px;
            padding:20px;
          }
        }
      `}</style>

      <div className="landing-hero">
        <p className="landing-kicker">
          ARCANE DECKSMITH
        </p>

        <h1 className="landing-title">
          Deine Karten.
          <span>Dein Arsenal.</span>
        </h1>

        <p className="landing-lead">
          Organisiere deine Magic-Sammlung, entdecke Karten,
          baue Decks und bringe deine Listen von der Idee bis
          zum fertigen Deck an einen Ort.
        </p>
      </div>

      <div className="landing-stats">
        <div className="landing-stat">
          <strong>
            {totalCopies}
          </strong>
          <span>
            Karten in der Sammlung
          </span>
        </div>

        <div className="landing-stat">
          <strong>
            {cards.length}
          </strong>
          <span>
            verschiedene Ausgaben
          </span>
        </div>

        <div className="landing-stat">
          <strong>
            {decks.length}
          </strong>
          <span>
            gespeicherte Decks
          </span>
        </div>

        <div className="landing-stat">
          <strong>
            {formatEuro(
              collectionValue
            )}
          </strong>
          <span>
            Sammlungswert
          </span>
        </div>
      </div>

      <div className="landing-section-head">
        <div>
          <p className="landing-kicker">
            WORKSPACE
          </p>
          <h2>
            Wohin möchtest du?
          </h2>
        </div>
      </div>

      <div className="landing-grid">
        {areas.map(area => (
          <button
            key={area.key}
            className="landing-card"
            onClick={() =>
              onNavigate(
                area.key
              )
            }
          >
            <div className="landing-card-top">
              <span className="landing-card-eyebrow">
                {area.eyebrow}
              </span>

              <span className="landing-card-icon">
                {area.icon}
              </span>
            </div>

            <h3>
              {area.title}
            </h3>

            <p>
              {area.text}
            </p>

            <div className="landing-card-footer">
              <span className="landing-card-meta">
                {area.meta}
              </span>

              <span className="landing-card-cta">
                {area.cta} →
              </span>
            </div>
          </button>
        ))}
      </div>
    </section>
  );
}


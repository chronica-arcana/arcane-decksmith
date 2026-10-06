import {
  APP_NAV_ITEMS,
  appPageHref,
  type AppPage
} from "../navigation";

export default function AppHeader({
  page,
  accountLabel,
  onSignOut,
  onMigrate
}: {
  page: AppPage;
  accountLabel: string;
  onSignOut: () => void;
  /** Öffnet die einmalige Komplett-Übernahme aus Firebase (nur für den Migrations-Admin). */
  onMigrate?: () => void;
}) {
  return (
    <header className="topbar">
      <a
        className="logo"
        href={appPageHref("home")}
        aria-label="Arcane Decksmith Startseite"
      >
        <img
          src="./ad_logo_192.png"
          alt="Arcane Decksmith Logo"
        />
        Arcane Decksmith
      </a>

      <nav aria-label="Hauptnavigation">
        {APP_NAV_ITEMS.map(item => (
          <a
            key={item.page}
            className={
              page === item.page
                ? "nav active"
                : "nav"
            }
            href={appPageHref(item.page)}
            aria-current={
              page === item.page
                ? "page"
                : undefined
            }
          >
            {item.label}
          </a>
        ))}
      </nav>

      <div className="userbox">
        <span>{accountLabel}</span>

        {onMigrate && (
          <button type="button" className="secondary" onClick={onMigrate}>
            Firebase-Migration
          </button>
        )}

        <button onClick={onSignOut}>
          Abmelden
        </button>
      </div>
    </header>
  );
}

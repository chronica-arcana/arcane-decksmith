import { describe, expect, it } from "vitest";
import { firebaseErrorMessage, parseFirebaseConfig, planMigration } from "./firebaseMigration";

describe("parseFirebaseConfig", () => {
  it("liest den kopierten JavaScript-Block", () => {
    const text = `// Import the functions
const firebaseConfig = {
  apiKey: "AIzaSyTest",
  authDomain: "demo.firebaseapp.com",
  projectId: "demo",
  storageBucket: "demo.firebasestorage.app",
  messagingSenderId: "123",
  appId: "1:123:web:abc"
};
const app = initializeApp(firebaseConfig);`;
    expect(parseFirebaseConfig(text)).toEqual({
      apiKey: "AIzaSyTest",
      authDomain: "demo.firebaseapp.com",
      projectId: "demo",
      storageBucket: "demo.firebasestorage.app",
      messagingSenderId: "123",
      appId: "1:123:web:abc"
    });
  });

  it("liest JSON mit Anführungszeichen und Einzelwerte in einfachen Anführungszeichen", () => {
    expect(parseFirebaseConfig('{"apiKey":"k","authDomain":"a.firebaseapp.com","projectId":"p"}').projectId).toBe("p");
    expect(parseFirebaseConfig("apiKey: 'k', authDomain: 'a', projectId: 'p'").apiKey).toBe("k");
  });

  it("nennt fehlende Pflichtwerte", () => {
    expect(() => parseFirebaseConfig('apiKey: "k"')).toThrow(/authDomain, projectId/);
    expect(() => parseFirebaseConfig("")).toThrow(/apiKey/);
  });
});

describe("planMigration", () => {
  const items = [{ id: "a" }, { id: "b" }, { id: "" }, {}, { id: 5 }];

  it("überspringt vorhandene und ungültige Einträge", () => {
    const plan = planMigration(items, new Set(["a"]), false);
    expect(plan.toWrite.map((i) => i.id)).toEqual(["b"]);
    expect(plan.skipped).toBe(4);
  });

  it("überschreibt vorhandene Einträge nur auf Wunsch", () => {
    const plan = planMigration(items, new Set(["a"]), true);
    expect(plan.toWrite.map((i) => i.id)).toEqual(["a", "b"]);
    expect(plan.skipped).toBe(3);
  });
});

describe("firebaseErrorMessage", () => {
  it("übersetzt häufige Fehler", () => {
    expect(firebaseErrorMessage({ code: "auth/invalid-credential" })).toContain("stimmen nicht");
    expect(firebaseErrorMessage({ code: "auth/requests-from-referer-https://x-are-blocked" })).toContain("Referrer");
    expect(firebaseErrorMessage({ code: "permission-denied" })).toContain("Regeln");
    expect(firebaseErrorMessage(new Error("Sonstiges"))).toBe("Sonstiges");
    expect(firebaseErrorMessage(null)).toContain("Firebase");
  });
});

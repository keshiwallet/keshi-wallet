import { useEffect, useState, type ReactNode } from "react";
import { getSettings } from "../ext/platform";
import { acceptTerms, getTerms, setCounting, termsAccepted } from "../ext/stats";

// Keshi's terms, shown once before the wallet (1.0.6), then one question: being counted, yes or no.
// Two separate steps on purpose. The terms are needed to use Keshi; counting is not: it is asked as a
// question with no answer chosen in advance, and Keshi works exactly the same after a "no".
// Text shown to users stays in English.

/** The terms, in plain words. Also shown in Settings. */
export const TERMS: { title: string; text: string }[] = [
  { title: "Your keys, your responsibility.", text: "Keshi never sees your recovery phrase or your password. If you lose them, nobody can restore your wallet, Keshi included." },
  { title: "No warranty.", text: 'Keshi is provided "as is", without warranty of any kind. Crypto transactions cannot be reversed, and prices move.' },
  { title: "Outside services.", text: "The networks, exchanges, swaps, the bridge, price sources and mining pools Keshi talks to are run by third parties, under their own terms. Keshi does not control them and is not responsible for them." },
  { title: "Fees.", text: "A Keshi fee, when there is one, is always shown before you confirm." },
  { title: "No advice.", text: "Nothing in Keshi is financial, legal or tax advice. You decide, and you check that using Keshi is lawful where you live." },
];

/** What counting sends, word for word what the signal holds (src/core/stats.ts). */
export const COUNTING_TEXT =
  "One anonymous signal a day at most: Keshi's version, your browser's name, and how many wallets this Keshi holds, has created and has restored (numbers only). Never your addresses, balances, recovery phrase or transactions. No identifier, and your IP address is not stored.";

export function TermsList() {
  return (
    <ol className="terms">
      {TERMS.map((t) => (
        <li key={t.title}>
          <b>{t.title}</b> {t.text}
        </li>
      ))}
    </ol>
  );
}

export function TermsGate({ children }: { children: ReactNode }) {
  const [step, setStep] = useState<"loading" | "ask" | "count" | "later" | "ok">("loading");
  const [agree, setAgree] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    getSettings()
      .then((st) => (document.documentElement.dataset.theme = st.theme))
      .catch(() => {});
    // Storage that cannot be read must never stand between someone and their wallet: the wallet opens.
    getTerms()
      .then((t) => setStep(termsAccepted(t) ? "ok" : "ask"))
      .catch(() => setStep("ok"));
  }, []);

  if (step === "ok") return <>{children}</>;
  if (step === "loading") return null;

  // The answer to the counting question is what records the terms: both are saved together, once.
  const answer = async (count: boolean) => {
    try {
      await acceptTerms(count);
      setStep("ok");
    } catch (e) {
      setError(`Your choice could not be saved (${e instanceof Error ? e.message : String(e)}). Try again.`);
    }
  };

  if (step === "later")
    return (
      <div className="screen terms-screen">
        <div className="body">
          <h2>Nothing was changed</h2>
          <p className="muted">Keshi stays closed until its terms are accepted. Your wallet, your addresses and your recovery phrase are exactly as they were, and nothing was sent.</p>
          <button className="btn" onClick={() => setStep("ask")}>
            Back to the terms
          </button>
        </div>
      </div>
    );

  // A question with two answers of the same size, and no answer chosen in advance: saying no is as easy as saying yes.
  if (step === "count")
    return (
      <div className="screen terms-screen" role="dialog" aria-labelledby="count-title">
        <div className="body">
          <p className="muted small">Step 2 of 2</p>
          <h2 id="count-title">Help us count Keshi wallets?</h2>
          <p>Keshi has no accounts and no tracking, so we cannot tell how many wallets are in use. Knowing it helps us decide what to build next for Pearl.</p>
          <div className="card">
            <ul className="count-facts">
              <li>
                <b>What is sent:</b> one anonymous signal a day at most. Keshi's version, your browser's name, and how many wallets this Keshi holds, has created and has restored (numbers only).
              </li>
              <li>
                <b>Never sent:</b> your addresses, balances, recovery phrase or transactions. No identifier, and your IP address is not stored.
              </li>
              <li>
                <b>Your call:</b> Keshi works exactly the same either way, and you can change your answer anytime in Settings &gt; Privacy.
              </li>
            </ul>
          </div>
          {error && (
            <p className="hint warn small" role="alert">
              {error}
            </p>
          )}
          <div className="row gap">
            <button className="btn" onClick={() => answer(false)}>
              No thanks
            </button>
            <button className="btn primary" onClick={() => answer(true)}>
              Yes, count me
            </button>
          </div>
          <button className="link small" onClick={() => setStep("ask")}>
            Back to the terms
          </button>
        </div>
      </div>
    );

  return (
    <div className="screen terms-screen" role="dialog" aria-labelledby="terms-title">
      <div className="body">
        <p className="muted small">Step 1 of 2</p>
        <h2 id="terms-title">Before you use Keshi</h2>
        <p className="muted small">Five points, in plain words. Already using Keshi? Nothing changes for your wallet: same keys, same addresses, same fees.</p>
        <TermsList />
        <label className="check">
          <input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} />
          <span>
            <b>I have read and accept these terms.</b>
          </span>
        </label>
        <div className="row gap">
          <button className="btn ghost" onClick={() => setStep("later")}>
            Not now
          </button>
          <button className="btn primary" disabled={!agree} onClick={() => setStep("count")}>
            Continue
          </button>
        </div>
        <p className="muted small">Questions: contact@keshiwallet.com</p>
      </div>
    </div>
  );
}

/** Settings > Privacy: the same choice, changeable at any time. */
export function CountingSetting() {
  const [on, setOn] = useState<boolean | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    getTerms()
      .then((t) => setOn(!!t?.count))
      .catch(() => setOn(false));
  }, []);
  const change = async (next: boolean) => {
    const before = on;
    setOn(next);
    setError("");
    try {
      await setCounting(next);
    } catch {
      setOn(before);
      setError("That choice could not be saved. Try again.");
    }
  };
  return (
    <>
      <label>
        Count my wallet (anonymous)
        <input type="checkbox" checked={!!on} disabled={on === null} onChange={(e) => change(e.target.checked)} />
      </label>
      <p className="small muted">On only if you answered yes. {COUNTING_TEXT} Turning it off also forgets the numbers waiting to be sent.</p>
      {error && <p className="hint warn small">{error}</p>}
    </>
  );
}

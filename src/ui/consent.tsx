import { useEffect, useState, type ReactNode } from "react";
import { giveConsent, hasConsent } from "../ext/consent";

// Firefox only: the data consent screen. One page, both choices the same size,
// and nothing is sent before "Accept". Text shown to users stays in English.

type Step = "loading" | "ask" | "declined" | "done" | "ok";

function removeKeshi(): boolean {
  const api = (globalThis as any).browser?.management ?? (globalThis as any).chrome?.management;
  if (!api?.uninstallSelf) return false;
  try {
    const r = api.uninstallSelf({ showConfirmDialog: true });
    if (r && typeof r.catch === "function") r.catch(() => {});
    return true;
  } catch {
    return false;
  }
}

export function ConsentGate({ children }: { children: ReactNode }) {
  const inTab = new URLSearchParams(location.search).has("consent");
  const [step, setStep] = useState<Step>("loading");
  const [noRemove, setNoRemove] = useState(false);

  useEffect(() => {
    if (inTab) document.body.classList.add("consent-tab");
    hasConsent().then((ok) => setStep(ok ? (inTab ? "done" : "ok") : "ask"));
  }, [inTab]);

  if (step === "ok") return <>{children}</>;
  if (step === "loading") return null;

  const accept = async () => {
    await giveConsent();
    setStep(inTab ? "done" : "ok");
  };

  return (
    <main className="consent" aria-labelledby="consent-title">
      {step === "ask" && (
        <>
          <h1 id="consent-title">Before you start</h1>
          <p className="consent-lede">
            Keshi is a wallet. To show your balance and send your payments, it has to send some of your data to outside services.
            <strong> Nothing is sent until you accept.</strong>
          </p>

          <section>
            <h2>What Keshi sends: financial and payment information</h2>
            <ul>
              <li>
                <b>Your wallet addresses</b>, to read your balance and history: the Pearl network indexer and public Ethereum nodes.
              </li>
              <li>
                <b>The payments, swaps, purchases and bridges you approve</b>, to carry them out: the Pearl and Ethereum networks, Flashbots
                Protect (private swaps), the Pearl bridge, and LI.FI through Keshi's relay (Buy with USDT).
              </li>
              <li>
                <b>Your payout address</b>, only if you choose to follow a miner: Kryptex or HeroMiners.
              </li>
            </ul>
          </section>

          <section>
            <h2>Never sent</h2>
            <p>Your recovery phrase, private keys and password stay on this device. No analytics, no tracking, no ads, no technical data.</p>
          </section>

          <section>
            <h2>Your choice</h2>
            <p>
              <b>Accept:</b> Keshi works normally. <b>Decline:</b> Keshi sends nothing, so it cannot show balances or send payments. You can
              remove it, or accept later by opening Keshi again.
            </p>
          </section>

          <div className="consent-actions">
            <button className="btn primary" onClick={accept}>
              Accept
            </button>
            <button className="btn primary" onClick={() => setStep("declined")}>
              Decline
            </button>
          </div>
        </>
      )}

      {step === "declined" && (
        <>
          <h1 id="consent-title">Nothing was sent</h1>
          <p className="consent-lede">
            Keshi cannot work without sending your addresses and the payments you approve to the networks. It will ask again the next time you
            open it.
          </p>
          {noRemove && <p>To remove Keshi, right-click its icon in the toolbar and choose "Remove Extension".</p>}
          <div className="consent-actions">
            <button className="btn primary" onClick={() => setStep("ask")}>
              Back
            </button>
            <button className="btn primary" onClick={() => setNoRemove(!removeKeshi())}>
              Remove Keshi
            </button>
          </div>
        </>
      )}

      {step === "done" && (
        <>
          <h1 id="consent-title">All set</h1>
          <p className="consent-lede">Click the Keshi icon in your toolbar to open your wallet.</p>
          <div className="consent-actions one">
            <button className="btn primary" onClick={() => window.close()}>
              Close this tab
            </button>
          </div>
        </>
      )}
    </main>
  );
}

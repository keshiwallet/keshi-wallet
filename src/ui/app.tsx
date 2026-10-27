import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import QRCode from "qrcode";
import * as core from "../core";
import { formatPrl, parsePrl, prlToNumber } from "../core";
import { local, session, getSettings, DEFAULT_SETTINGS, isExtension, type Contact, type DappRequest, type Settings, type Site } from "../ext/platform";
import * as store from "./store";

type Tab = "wallet" | "swap" | "explore" | "activity" | "mining" | "settings";
type Sheet =
  | null
  | { kind: "send"; to?: string; amount?: string; max?: boolean; title?: string; combine?: boolean; bridgeTo?: string; locked?: boolean }
  | { kind: "bridge"; amount?: string }
  | { kind: "trade"; side: "buy" | "sell" }
  | { kind: "receive" }
  | { kind: "tx"; tx: core.Activity; flag?: core.Flag }
  | { kind: "ethtx"; tx: core.EthActivity }
  | { kind: "tokens" }
  | { kind: "asset"; asset: "ETH" | "wPRL" }
  | { kind: "ethsend"; asset: "ETH" | "wPRL" }
  | { kind: "prl" };

const short = (a: string, n = 8) => (a.length > 2 * n + 3 ? `${a.slice(0, n + 4)}…${a.slice(-n)}` : a);
const usd = (n: number) =>
  n > 0 && n < 0.01
    ? "$" + n.toFixed(Math.min(12, 1 - Math.floor(Math.log10(n)))).replace(/0+$/, "")
    : n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: n < 1 ? 4 : 2 });
const when = (t: number) =>
  t ? new Date(t * 1000).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "Pending";
const compact = (n: number) => new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 }).format(n);
const usdCompact = (n: number) => "$" + compact(n);
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
/** ETH to 5 decimals; a tiny balance shows its first digits instead of reading as nothing. */
const fmtEth = (wei: bigint): string => {
  if (wei === 0n) return "0";
  const five = core.formatEth(wei, 5);
  if (five !== "0.00000") return five;
  const eight = core.formatEth(wei, 8);
  return eight === "0.00000000" ? "under 0.00000001" : eight.replace(/0+$/, "");
};

/**
 * Clears the clipboard 30 s after a secret was copied. Keshi does not read the clipboard (that would
 * need another permission), so it simply overwrites it while this screen is still open; once the
 * popup is closed, the timer is gone with it.
 */
function wipeClipboardLater() {
  setTimeout(() => navigator.clipboard?.writeText("").catch(() => {}), 30_000);
}

function useCopy(): [string | null, (text: string, tag?: string, secret?: boolean) => void] {
  const [copied, setCopied] = useState<string | null>(null);
  return [
    copied,
    (text, tag = text, secret = false) => {
      navigator.clipboard?.writeText(text).catch(() => {});
      if (secret) wipeClipboardLater();
      setCopied(tag);
      setTimeout(() => setCopied(null), 1400);
    },
  ];
}

declare const __KESHI_UNLOCK__: string | undefined;
const UNLOCK_STYLE: "" | "nacre" | "dial" = typeof __KESHI_UNLOCK__ === "string" && (__KESHI_UNLOCK__ === "nacre" || __KESHI_UNLOCK__ === "dial") ? __KESHI_UNLOCK__ : "";
const KESHI_VERSION = "1.0.3";
const SUPPORT_EMAIL = "contact@keshiwallet.com";

const ICONS: Record<string, string> = {
  explore: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM15.5 8.5l-2 5-5 2 2-5 5-2Z",
  wallet: "M3.5 7.5A2.5 2.5 0 0 1 6 5h11v3M3.5 7.5v9A2.5 2.5 0 0 0 6 19h13.5V8H6a2.5 2.5 0 0 1-2.5-.5ZM16 13.5h.01",
  swap: "M7 4 3.5 7.5 7 11M3.5 7.5h13M17 13l3.5 3.5L17 20M20.5 16.5h-13",
  activity: "M4 6h16M4 12h16M4 18h10",
  mining: "M14 4c2.5.3 4.6 1.6 6 3.5M14 4 4.5 13.5M14 4l-1.5 4.5L17 12l2.5-1.5M4.5 13.5 3 19l5.5-1.5L17 9",
  settings: "M4 7h9M17 7h3M4 17h3M11 17h9M15 9.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5ZM9 19.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z",
  send: "M7 17 17 7M9 7h8v8",
  receive: "M17 7 7 17M15 17H7V9",
  buy: "M12 5v14M5 12h14",
  sell: "M5 12h14",
  moon: "M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z",
  sun: "M12 4V2M12 22v-2M4 12H2M22 12h-2M5.6 5.6 4.2 4.2M19.8 19.8l-1.4-1.4M5.6 18.4l-1.4 1.4M19.8 4.2l-1.4 1.4M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z",
  lock: "M7 10.5V8a5 5 0 0 1 10 0v2.5M6 10.5h12v9H6v-9Z",
  eye: "M2.5 12s3.5-6.5 9.5-6.5S21.5 12 21.5 12s-3.5 6.5-9.5 6.5S2.5 12 2.5 12ZM12 14.8a2.8 2.8 0 1 0 0-5.6 2.8 2.8 0 0 0 0 5.6Z",
  down: "M6 9.5l6 6 6-6",
  chevron: "M9.5 6l6 6-6 6",
  warn: "M12 4.5 3.5 19h17L12 4.5ZM12 10.5v4M12 17h.01",
  refresh: "M19.5 12a7.5 7.5 0 1 1-2.2-5.3M19.5 4.5v3.2h-3.2",
  switch: "M8 4v16M8 4 4.5 7.5M8 4l3.5 3.5M16 20V4M16 20l-3.5-3.5M16 20l3.5-3.5",
};
function Icon({ name, size = 20 }: { name: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={ICONS[name]} />
    </svg>
  );
}

const COIN_COLORS: Record<string, string> = { USDT: "#26a17b", USDC: "#2775ca", DAI: "#e9a23b" };
// Official marks: the Pearl "P" (Pearl Research Labs, ISC licence) and the Ethereum diamond (CC0 icon set).
const PEARL_MARK = ["M172.982 29.9973H240.204C304 30 347 59 347 108.5C347 154 307 187 240 187V170C284 168 300 142 300 108C300 70 274 47 234 47H218V263H265V280H131V263H172.982V29.9973Z", "M135 186.934C69.6493 186.934 29 157.511 29 108.249C29 62.9709 67.7444 29.9969 135 29.9969L135 186.934Z"];
const ETH_MARK = [[".602", "M16.498 4v8.87l7.497 3.35z"], ["1", "M16.498 4L9 16.22l7.498-3.35z"], [".602", "M16.498 21.968v6.027L24 17.616z"], ["1", "M16.498 27.995v-6.028L9 17.616z"], [".2", "M16.498 20.573l7.497-4.353-7.497-3.348z"], [".602", "M9 16.22l7.498 4.353v-7.701z"]];
/** A round badge for an asset: the real Pearl and Ethereum logos for PRL/wPRL and ETH/WETH, a steady colour for everything else. */
function Coin({ name, native = false, mini = false }: { name: string; native?: boolean; mini?: boolean }) {
  const n = name.toUpperCase();
  const m = mini ? " mini" : "";
  // The official marks are reserved for the real assets: a token that merely
  // calls itself "PRL" or "ETH" gets a plain badge.
  if (native && (n === "PRL" || n === "WPRL"))
    return (
      <span className={`coin brand prl${n === "WPRL" ? " wrapped" : ""}${m}`} aria-hidden="true">
        <svg viewBox="0 0 376 310">{PEARL_MARK.map((d, i) => <path key={i} d={d} fill="currentColor" />)}</svg>
      </span>
    );
  if (native && (n === "ETH" || n === "WETH"))
    return (
      <span className={`coin brand eth${n === "WETH" ? " wrapped" : ""}${m}`} aria-hidden="true">
        <svg viewBox="0 0 32 32">{ETH_MARK.map(([o, d], i) => <path key={i} d={d} fill="#fff" fillOpacity={o} />)}</svg>
      </span>
    );
  let h = 0;
  for (const c of n) h = (h * 31 + c.charCodeAt(0)) % 360;
  return (
    <span className={`coin${m}`} style={{ background: (native && COIN_COLORS[n]) || `hsl(${h} 38% 44%)`, color: "#fff" }} aria-hidden="true">
      {n[0]}
    </span>
  );
}

/** An address with its start and end emphasised: the parts people actually compare. */
/** A QR code drawn as an image (never as raw HTML), from the SVG text the qrcode library made on this device. */
function QrImage({ svg, small }: { svg: string; small?: boolean }) {
  return <div className={small ? "qr small" : "qr"}>{svg && <img src={"data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg)} alt="QR code" />}</div>;
}

/** The wallet's own Ethereum address, with a QR code, for topping up ETH or wPRL. */
function EthAddressCard({ address, title = "Your Ethereum address in Keshi", chain, children }: { address: string; title?: string; /** Named when the card is shown for another EVM chain (Arbitrum…): the note then says the address is the same everywhere. */ chain?: string; children?: ReactNode }) {
  const [svg, setSvg] = useState("");
  const [copied, copy] = useCopy();
  useEffect(() => {
    QRCode.toString(address, { type: "svg", margin: 0, errorCorrectionLevel: "M", color: { dark: "#000000", light: "#ffffff" } }).then(setSvg);
  }, [address]);
  return (
    <div className="card eth-card">
      <strong>{title}</strong>
      <QrImage svg={svg} small />
      <p className="addr-box"><Addr value={address} /></p>
      <button className="btn" onClick={() => copy(address)}>
        {copied ? "Copied" : chain ? "Copy address" : "Copy Ethereum address"}
      </button>
      {children}
      <p className="muted small">
        {chain
          ? `Your EVM address: the same on ${chain}, Ethereum, Arbitrum, BNB Chain and Polygon. Send USDT to it on ${chain} only. Never send PRL to this address.`
          : "Ethereum network only: ETH, wPRL and other Ethereum tokens. Never send PRL to this address."}
      </p>
    </div>
  );
}

function Addr({ value, className = "addr" }: { value: string; className?: string }) {
  if (value.length < 24) return <span className={className}>{value}</span>;
  return (
    <span className={className}>
      <b>{value.slice(0, 8)}</b>
      <i>{value.slice(8, -6)}</i>
      <b>{value.slice(-6)}</b>
    </span>
  );
}

function Skeleton({ rows = 4 }: { rows?: number }) {
  return (
    <ul className="skeleton" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <li key={i}>
          <span />
          <span />
        </li>
      ))}
    </ul>
  );
}

const dayOf = (t: number): string => {
  if (!t) return "Pending";
  const d = new Date(t * 1000);
  const days = Math.round((new Date().setHours(0, 0, 0, 0) - new Date(d).setHours(0, 0, 0, 0)) / 86_400_000);
  return days === 0 ? "Today" : days === 1 ? "Yesterday" : d.toLocaleDateString("en-GB", { day: "numeric", month: "long" });
};
const timeOf = (t: number): string => (t ? new Date(t * 1000).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }) : "Waiting for confirmation");

/** How hard a password is to guess, 0 (too short) to 3 (strong). */
function strength(pw: string): number {
  if (pw.length < 10 || /^(\d+|(.)\2+)$/.test(pw)) return 0;
  const kinds = [/[a-z]/, /[A-Z]/, /\d/, /[^a-zA-Z\d]/].filter((r) => r.test(pw)).length;
  return pw.length >= 16 || (pw.length >= 12 && kinds >= 3) ? 3 : pw.length >= 12 || kinds >= 3 ? 2 : 1;
}
const STRENGTH = ["Too short", "Fair", "Good", "Strong"];

export function Mark({ size = 28 }: { size?: number }) {
  return <img src="icon/128.png" width={size} height={size} alt="" className="mark" />;
}

/* ------------------------------------------------------------------ App */

export function App() {
  const [stage, setStage] = useState<"loading" | "welcome" | "locked" | "ready">("loading");
  // After "Forgot your password?": the device is wiped and Keshi opens on restore.
  const [startOn, setStartOn] = useState<"start" | "restore">("start");
  const [secrets, setSecrets] = useState<core.Secrets | null>(null);
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const approveId = useMemo(() => new URLSearchParams(location.search).get("approve"), []);
  // The wallet in use, out of those kept in the vault.
  const current = useMemo(() => (secrets ? core.selectWallet(secrets, settings.wallet ?? 0) : null), [secrets, settings.wallet]);

  useEffect(() => {
    (async () => {
      const st = await getSettings();
      setSettings(st);
      document.documentElement.dataset.theme = st.theme;
      if (!(await store.hasWallet())) return setStage("welcome");
      const s = await store.resume();
      if (s) {
        setSecrets(s);
        setStage("ready");
      } else setStage("locked");
    })();
  }, []);

  // A window left open must lock with the rest: when the session ends (timer,
  // "Lock wallet now" in another window), drop the keys held here too.
  useEffect(() => {
    if (stage !== "ready") return;
    const check = async () => {
      if (await store.stillUnlocked()) return;
      await store.lock();
      setSecrets(null);
      setStage("locked");
    };
    const id = setInterval(check, 15_000);
    // Using the wallet keeps it open; leaving it alone lets it lock.
    const active = () => void store.touch();
    window.addEventListener("pointerdown", active);
    window.addEventListener("keydown", active);
    const onChange = (changes: Record<string, unknown>, areaName: string) => {
      if (areaName === "session" && "unlocked" in changes) void check();
    };
    if (isExtension) chrome.storage.onChanged.addListener(onChange);
    // Phones pause timers in the background: check again the moment the app is back.
    const back = () => document.visibilityState === "visible" && void check();
    document.addEventListener("visibilitychange", back);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", back);
      window.removeEventListener("pointerdown", active);
      window.removeEventListener("keydown", active);
      if (isExtension) chrome.storage.onChanged.removeListener(onChange);
    };
  }, [stage]);

  const saveSettings = async (patch: Partial<Settings>) => {
    const next = { ...settings, ...patch };
    setSettings(next);
    document.documentElement.dataset.theme = next.theme;
    await local.set("settings", next);
  };

  if (stage === "loading") return <div className="screen center" />;
  if (stage === "welcome")
    return (
      <Onboarding
        start={startOn}
        onDone={(s) => {
          // The Ethereum side (ETH, wPRL) shows from the start, like every multi-chain wallet: buying with USDT and
          // the bridge both live there. Settings > Privacy > "Check Ethereum automatically" turns it off for those who prefer.
          setSecrets(s);
          setStage("ready");
        }}
      />
    );
  if (stage === "locked" || !secrets || !current)
    return (
      <Unlock
        onDone={(s) => {
          setSecrets(s);
          setStage("ready");
        }}
        onErased={() => {
          setSettings(DEFAULT_SETTINGS);
          document.documentElement.dataset.theme = DEFAULT_SETTINGS.theme;
          setStartOn("restore");
          setStage("welcome");
        }}
      />
    );
  const onLock = async () => {
    await store.lock();
    setSecrets(null);
    setStage("locked");
  };
  if (approveId) return <Approve id={approveId} secrets={current} settings={settings} />;
  return <Main secrets={current} setSecrets={setSecrets} settings={settings} saveSettings={saveSettings} onLock={onLock} />;
}

/* ----------------------------------------------------------- Onboarding */

/** Where the user is in a short sequence of screens. */
function Steps({ at, of }: { at: number; of: number }) {
  return (
    <div className="steps" role="img" aria-label={`Step ${at} of ${of}`}>
      {Array.from({ length: of }, (_, i) => (
        <i key={i} className={i < at ? "on" : ""} />
      ))}
      <span>
        Step {at} of {of}
      </span>
    </div>
  );
}

function Onboarding({ onDone, start = "start" }: { onDone: (s: core.Secrets, fresh: boolean) => void; start?: "start" | "restore" }) {
  const [step, setStep] = useState<"start" | "phrase" | "check" | "restore" | "password">(start);
  const [phrase, setPhrase] = useState("");
  const [restoring, setRestoring] = useState(start === "restore");
  const [saved, setSaved] = useState(false);
  const [answers, setAnswers] = useState<Record<number, string>>({});
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [understood, setUnderstood] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [fresh, setFresh] = useState<"checking" | "yes" | "unknown">("unknown");
  const regenerated = useRef(0);
  const words = phrase.split(" ");
  // A new phrase is random enough to be this user's alone; the network check makes that visible.
  useEffect(() => {
    if (restoring || !phrase || step !== "phrase") return;
    let live = true;
    setFresh("checking");
    void core.phraseIsUnused(phrase).then((unused) => {
      if (!live) return;
      if (unused === false && regenerated.current < 3) {
        // Never seen in practice: throw the phrase away and make another. A server that always says "used" cannot keep this going forever.
        regenerated.current += 1;
        setPhrase(core.newPhrase(phrase.split(" ").length === 12 ? 12 : 24));
        setSaved(false);
        setAnswers({});
        return;
      }
      setFresh(unused ? "yes" : "unknown");
    });
    return () => {
      live = false;
    };
  }, [phrase, restoring, step]);
  const quiz = useMemo(() => {
    const picks = new Set<number>();
    const rnd = new Uint32Array(8);
    crypto.getRandomValues(rnd);
    for (const r of rnd) if (picks.size < 3) picks.add(r % words.length);
    return [...picks].sort((a, b) => a - b);
  }, [phrase]);

  const finish = async () => {
    setError("");
    if (pw.length < 10) return setError("Use at least 10 characters");
    if (/^(\d+|(.)\2+)$/.test(pw)) return setError("Choose something harder to guess than digits only or one repeated character");
    if (pw !== pw2) return setError("The two passwords do not match");
    setBusy(true);
    try {
      onDone(await store.createWallet(phrase, pw, restoring), !restoring);
    } catch (e) {
      setError(errText(e));
      setBusy(false);
    }
  };

  if (step === "start" && UNLOCK_STYLE === "dial")
    return (
      <div className="screen welcome orbit">
        <div className="stage" aria-hidden="true">
          <div className="glow" />
          <div className="ring ticks" />
          <div className="ring arc" />
          <div className="ring arc b" />
          <img className="core" src="icon/128.png" alt="" />
        </div>
        <h1 className="word up">Keshi</h1>
        <p className="slogan up">Pure Pearl. Your keys.</p>
        <p className="lede up">The wallet for Pearl. Your keys are made and kept on this device, and nowhere else.</p>
        <div className="stack up">
          <button
            className="btn primary"
            onClick={() => {
              setPhrase(core.newPhrase());
              setRestoring(false);
              setStep("phrase");
            }}
          >
            Create a new wallet
          </button>
          <button
            className="btn"
            onClick={() => {
              setPhrase("");
              setRestoring(true);
              setStep("restore");
            }}
          >
            I already have a recovery phrase
          </button>
          <p className="muted small fine">No account. No e-mail. Free.</p>
        </div>
      </div>
    );
  if (step === "start")
    return (
      <div className="screen welcome">
        <div className="pearl big" aria-hidden="true" />
        <div className="brand">
          <Mark size={34} />
          <h1>Keshi</h1>
        </div>
        <p className="slogan">Pure Pearl. Your keys.</p>
        <p className="lede">The wallet for Pearl. Your keys are made and kept on this device, and nowhere else.</p>
        <div className="stack">
          <button
            className="btn primary"
            onClick={() => {
              setPhrase(core.newPhrase());
              setRestoring(false);
              setStep("phrase");
            }}
          >
            Create a new wallet
          </button>
          <button
            className="btn"
            onClick={() => {
              setPhrase("");
              setRestoring(true);
              setStep("restore");
            }}
          >
            I already have a recovery phrase
          </button>
        </div>
      </div>
    );

  if (step === "phrase")
    return (
      <div className="screen">
        <Header title="Your recovery phrase" onBack={() => setStep("start")} />
        <Steps at={1} of={3} />
        <div className="seg">
          {([12, 24] as const).map((n) => (
            <button
              key={n}
              className={words.length === n ? "on" : ""}
              onClick={() => {
                if (words.length === n) return;
                setPhrase(core.newPhrase(n));
                setSaved(false);
                setAnswers({});
              }}
            >
              {n} words
              <small>{n === 12 ? "quicker to write down" : "strongest"}</small>
            </button>
          ))}
        </div>
        <p className="muted">
          Write these {words.length} words on paper, in order. They are the only way to get your PRL back if this device is lost. Anyone who has them can take your PRL.
        </p>
        <ol className="words">
          {words.map((w, i) => (
            <li key={i}>{w}</li>
          ))}
        </ol>
        {fresh === "checking" && <p className="muted small">Checking on the Pearl network that this wallet has never been used…</p>}
        {fresh === "yes" && <p className="fresh small">Checked on the Pearl network: this wallet has never been used. Its words were made on this device and nowhere else.</p>}
        <label className="check">
          <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} />
          <span>I wrote the words down and stored them somewhere safe</span>
        </label>
        <div className="grow" />
        <button className="btn primary" disabled={!saved} onClick={() => setStep("check")}>
          Continue
        </button>
      </div>
    );

  if (step === "check") {
    const ok = quiz.every((i) => (answers[i] ?? "").trim().toLowerCase() === words[i]);
    return (
      <div className="screen">
        <Header title="Check your copy" onBack={() => setStep("phrase")} />
        <Steps at={2} of={3} />
        <p className="muted">Type these three words from your paper copy.</p>
        {quiz.map((i) => (
          <label className="field" key={i}>
            <span>Word {i + 1}</span>
            <input autoComplete="off" spellCheck={false} value={answers[i] ?? ""} onChange={(e) => setAnswers({ ...answers, [i]: e.target.value })} />
          </label>
        ))}
        <div className="grow" />
        <button className="btn primary" disabled={!ok} onClick={() => setStep("password")}>
          Continue
        </button>
      </div>
    );
  }

  if (step === "restore") {
    const valid = core.isValidPhrase(phrase);
    const count = phrase.trim() ? phrase.trim().split(/\s+/).length : 0;
    return (
      <div className="screen">
        <Header title="Restore a wallet" onBack={() => setStep("start")} />
        <Steps at={1} of={2} />
        <p className="muted">Enter your 12 or 24 word recovery phrase. Phrases made by Keshi or by any standard Pearl wallet work here.</p>
        <label className="field">
          <span>Recovery phrase</span>
          <textarea rows={5} autoComplete="off" spellCheck={false} value={phrase} onChange={(e) => setPhrase(e.target.value)} />
        </label>
        {count > 0 && !valid && <p className="hint">{count} words so far. The phrase is not valid yet: check the spelling and the order.</p>}
        <div className="grow" />
        <button
          className="btn primary"
          disabled={!valid}
          onClick={() => {
            setPhrase(core.cleanPhrase(phrase));
            setStep("password");
          }}
        >
          Continue
        </button>
      </div>
    );
  }

  return (
    <div className="screen">
      <Header title="Choose a password" onBack={() => setStep(restoring ? "restore" : "check")} />
      <Steps at={restoring ? 2 : 3} of={restoring ? 2 : 3} />
      <p className="muted">The password locks the wallet on this device. It cannot be reset: if you forget it, restore with your recovery phrase.</p>
      <label className="field">
        <span>Password</span>
        <span className="with-eye">
          <input type={showPw ? "text" : "password"} value={pw} onChange={(e) => setPw(e.target.value)} autoFocus />
          <button type="button" onClick={() => setShowPw(!showPw)} aria-label={showPw ? "Hide password" : "Show password"} aria-pressed={showPw}>
            <Icon name="eye" size={18} />
          </button>
        </span>
      </label>
      {pw && (
        <div className={`meter s${strength(pw)}`} role="status">
          <span><i /><i /><i /><i /></span>
          {pw.length < 10 ? `${10 - pw.length} more character${10 - pw.length === 1 ? "" : "s"} needed` : STRENGTH[strength(pw)]}
        </div>
      )}
      <label className="field">
        <span>Repeat password</span>
        <input type={showPw ? "text" : "password"} value={pw2} onChange={(e) => setPw2(e.target.value)} onKeyDown={(e) => e.key === "Enter" && understood && finish()} />
      </label>
      <label className="check">
        <input type="checkbox" checked={understood} onChange={(e) => setUnderstood(e.target.checked)} />
        <span>I understand Keshi cannot reset this password. Only my recovery phrase can restore the wallet.</span>
      </label>
      {error && <p className="error">{error}</p>}
      <div className="grow" />
      <button className="btn primary" disabled={busy || !understood} onClick={finish}>
        {busy ? "Encrypting…" : restoring ? "Restore wallet" : "Create wallet"}
      </button>
    </div>
  );
}

/**
 * The password cannot be reset. What the user can do instead, with the recovery
 * phrase in hand: wipe Keshi on this device and restore. Guarded twice, because
 * without the phrase this loses the wallet for good.
 */
function ForgotPassword({ onBack, onErased }: { onBack: () => void; onErased: () => void }) {
  const [havePhrase, setHavePhrase] = useState(false);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const erase = async () => {
    setBusy(true);
    setError("");
    try {
      await store.eraseDevice();
      onErased();
    } catch (e) {
      setError(errText(e));
      setBusy(false);
    }
  };
  return (
    <div className="screen">
      <Header title="Forgot your password?" onBack={onBack} />
      <p>Your password cannot be reset or recovered: it never leaves this device, and Keshi never knows it.</p>
      <div className="card">
        <p>
          <b>If you have your recovery phrase</b> (the 12 or 24 words), erase Keshi on this device and restore your wallet with it. Your funds are on the blockchain, not on this device: they come back with the phrase, under a new password.
        </p>
      </div>
      <p className="hint warn">
        <b>Without the recovery phrase, do not erase.</b> Erasing removes every wallet kept in Keshi on this device, and nobody can bring them back. Keep trying your password instead.
      </p>
      <label className="check">
        <input type="checkbox" checked={havePhrase} onChange={(e) => setHavePhrase(e.target.checked)} />
        <span>I have the recovery phrase (or private key) of every wallet I keep in Keshi, written down.</span>
      </label>
      <label className="field">
        <span>Type ERASE to confirm</span>
        <input value={typed} autoComplete="off" spellCheck={false} onChange={(e) => setTyped(e.target.value)} placeholder="ERASE" />
      </label>
      {error && <p className="error">{error}</p>}
      <div className="grow" />
      <button className="btn sell" disabled={busy || !havePhrase || typed.trim() !== "ERASE"} onClick={erase}>
        {busy ? "Erasing…" : "Erase and restore with my phrase"}
      </button>
      <button className="btn" onClick={onBack}>
        Back to unlock
      </button>
    </div>
  );
}

function Unlock({ onDone, onErased }: { onDone: (s: core.Secrets) => void; onErased: () => void }) {
  const [forgot, setForgot] = useState(false);
  const [pw, setPw] = useState("");
  const [code, setCode] = useState("");
  const [needCode, setNeedCode] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [state, setState] = useState<"idle" | "wrong" | "open">("idle");
  const running = useRef(false);
  const go = async () => {
    if (running.current || !pw) return; // one attempt at a time, so each wrong password is counted
    running.current = true;
    setBusy(true);
    setError("");
    try {
      const s = await store.unlock(pw, code);
      if (UNLOCK_STYLE) {
        // The pearl opens, then the wallet appears. Short on purpose: the wallet must not feel slow.
        setState("open");
        setTimeout(() => onDone(s), UNLOCK_STYLE === "dial" ? 1500 : 1300);
      } else onDone(s);
    } catch (e) {
      if (errText(e) === store.CODE_NEEDED) setNeedCode(true);
      else {
        setError(errText(e));
        setState("wrong");
      }
      setBusy(false);
      running.current = false;
    }
  };
  const typed = pw.length;
  if (forgot) return <ForgotPassword onBack={() => setForgot(false)} onErased={onErased} />;
  const onType = (v: string) => {
    setPw(v);
    if (state === "wrong") setState("idle");
    setError("");
  };
  if (!UNLOCK_STYLE)
    return (
      <div className="screen welcome">
        <div className="pearl big" aria-hidden="true" />
        <div className="brand">
          <Mark size={34} />
          <h1>Keshi</h1>
        </div>
        <p className="slogan">Welcome back.</p>
        <p className="lede">Enter your password to open your wallet.</p>
        <div className="stack">
          <label className="field">
            <span>Password</span>
            <input type="password" value={pw} autoFocus onChange={(e) => setPw(e.target.value)} onKeyDown={(e) => e.key === "Enter" && go()} />
          </label>
          {needCode && (
            <label className="field">
              <span>Code from your authenticator app</span>
              <input inputMode="numeric" autoComplete="one-time-code" placeholder="000000" maxLength={7} value={code} autoFocus onChange={(e) => setCode(e.target.value)} onKeyDown={(e) => e.key === "Enter" && go()} />
            </label>
          )}
          {error && <p className="error">{error}</p>}
          <button className="btn primary" disabled={busy || !pw || (needCode && code.replace(/\s/g, "").length < 6)} onClick={go}>
            {busy ? "Unlocking…" : "Unlock"}
          </button>
          <button className="link" onClick={() => setForgot(true)}>
            Forgot your password?
          </button>
        </div>
      </div>
    );
  // The pearl as the lock: it reacts to each letter, opens on the right password, refuses a wrong one.
  const canGo = !busy && !!pw && !(needCode && code.replace(/\s/g, "").length < 6);
  return (
    <div className={`screen unlock ${UNLOCK_STYLE} ${state}`}>
      <div className="stage" style={{ ["--r" as string]: `${(typed % 2 ? 1 : -1) * (20 + typed * 17)}deg` }} aria-hidden="true">
        {UNLOCK_STYLE === "nacre" ? (
          <>
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className={`layer${typed > i * 1.5 ? " lit" : ""}`} />
            ))}
            <img className="core" src="icon/128.png" alt="" />
            <div className="glint" />
          </>
        ) : (
          <>
            <div className="arc a" />
            <div className="arc b" />
            <div className="ticks" />
            <div className="tick-mark" />
            <div className="click" />
            <img className="core" src="icon/128.png" alt="" />
          </>
        )}
      </div>
      <div className={`form${state === "open" ? " gone" : ""}`}>
        <p className="wm">Welcome back.</p>
        <div className="line">
          <input type="password" placeholder="Password" aria-label="Password" value={pw} autoFocus className={state === "wrong" ? "bad" : ""} onChange={(e) => onType(e.target.value)} onKeyDown={(e) => e.key === "Enter" && go()} />
          <i style={{ width: `${Math.min(100, typed * 14)}%` }} />
        </div>
        {needCode && (
          <div className="line">
            <input inputMode="numeric" autoComplete="one-time-code" placeholder="Code from your authenticator app" aria-label="Code from your authenticator app" maxLength={7} value={code} autoFocus onChange={(e) => setCode(e.target.value)} onKeyDown={(e) => e.key === "Enter" && go()} />
            <i />
          </div>
        )}
        <p className="err">{error}</p>
        <button className="go" disabled={!canGo} onClick={go}>
          {busy ? "Opening…" : "Unlock"}
        </button>
        <button className="forgot" onClick={() => setForgot(true)}>
          Forgot your password?
        </button>
      </div>
    </div>
  );
}

function Header({ title, onBack, right }: { title: string; onBack?: () => void; right?: ReactNode }) {
  return (
    <header className="head">
      {onBack && (
        <button className="icon" onClick={onBack} aria-label="Back">
          <svg width="18" height="18" viewBox="0 0 18 18"><path d="M11 3 5 9l6 6" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </button>
      )}
      <h2>{title}</h2>
      <div className="grow" />
      {right}
    </header>
  );
}

/* ----------------------------------------------------------------- Main */

interface MainProps {
  secrets: core.Secrets;
  setSecrets: (s: core.Secrets) => void;
  settings: Settings;
  saveSettings: (p: Partial<Settings>) => Promise<void>;
  onLock: () => void;
}

function useMarket(quote: core.Quote) {
  const [ticker, setTicker] = useState<core.Ticker | null>(null);
  const [info, setInfo] = useState<core.MarketInfo | null>(null);
  useEffect(() => {
    let alive = true;
    setTicker(null);
    const load = () => {
      new core.Exchange(undefined, undefined, quote).ticker().then((t) => alive && Number.isFinite(t.last) && t.last > 0 && setTicker(t)).catch(() => {});
      new core.MarketData().info().then((i) => alive && setInfo(i)).catch(() => {});
    };
    load();
    const id = setInterval(load, 30_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [quote]);
  return { ticker, info };
}

function Main({ secrets, setSecrets, settings, saveSettings, onLock }: MainProps) {
  const net = core.networkById(settings.network);
  const [tab, setTab] = useState<Tab>("wallet");
  const [sheet, setSheet] = useState<Sheet>(null);
  const [snap, setSnap] = useState<core.Snapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const { ticker, info } = useMarket("usdt");
  const livePrice = ticker?.last ?? info?.price ?? null;
  const price = settings.network === "mainnet" ? livePrice : null;

  const reload = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      setSnap(await store.refresh(secrets, net));
    } catch (e) {
      setError(e instanceof store.IndexerBehind ? e.message : "Could not reach the Pearl network. Showing the last known balance.");
    } finally {
      setLoading(false);
    }
  }, [secrets, net.id]);

  useEffect(() => {
    setSnap(null);
    store.loadCached(secrets, net).then((c) => c && setSnap((s) => s ?? c));
    reload();
    const id = setInterval(reload, 60_000);
    return () => clearInterval(id);
  }, [reload]);

  const ctx = { secrets, net, snap, price, reload, settings, saveSettings };

  if (sheet?.kind === "send") return <Send {...ctx} preset={sheet} onClose={() => setSheet(null)} />;
  if (sheet?.kind === "receive") return <Receive {...ctx} onClose={() => setSheet(null)} />;
  if (sheet?.kind === "trade") return <TradeSheet {...ctx} side={sheet.side} setSecrets={setSecrets} open={setSheet} onClose={() => setSheet(null)} />;
  if (sheet?.kind === "bridge") return <BridgeSheet {...ctx} preset={sheet.amount} open={setSheet} onClose={() => setSheet(null)} />;
  if (sheet?.kind === "tx") return <TxDetail {...ctx} tx={sheet.tx} flag={sheet.flag} onClose={() => setSheet(null)} />;
  if (sheet?.kind === "ethtx") return <EthTxDetail {...ctx} tx={sheet.tx} onClose={() => setSheet(null)} />;
  if (sheet?.kind === "asset") return <EthAsset {...ctx} asset={sheet.asset} open={setSheet} onClose={() => setSheet(null)} />;
  if (sheet?.kind === "prl") return <PrlAsset {...ctx} open={setSheet} onClose={() => setSheet(null)} />;
  if (sheet?.kind === "ethsend") return <EthSend {...ctx} asset={sheet.asset} onClose={() => setSheet({ kind: "asset", asset: sheet.asset })} />;
  if (sheet?.kind === "tokens")
    return (
      <div className="screen">
        <Tokens {...ctx} prlUsd={livePrice} onClose={() => setSheet(null)} />
      </div>
    );

  return (
    <div className="screen app">
      <div className="body">
        {tab === "wallet" && <Home {...ctx} info={info} ticker={ticker} loading={loading} error={error} open={setSheet} toggleUnit={() => saveSettings({ unit: settings.unit === "usd" ? "prl" : "usd" })} setTheme={(theme) => saveSettings({ theme })} pickWallet={(wallet) => saveSettings({ wallet })} onLock={onLock} />}
        {tab === "swap" && <Swap {...ctx} open={setSheet} />}
        {tab === "activity" && <ActivityTab {...ctx} open={setSheet} />}
        {tab === "mining" && <Mining {...ctx} open={setSheet} />}
        {tab === "explore" && <Explore />}
        {tab === "settings" && <SettingsTab {...ctx} setSecrets={setSecrets} saveSettings={saveSettings} onLock={onLock} />}
      </div>
      <nav className="tabs">
        {(["wallet", "swap", "explore", "activity", "mining", "settings"] as Tab[]).map((t) => (
          <button key={t} className={tab === t ? "on" : ""} onClick={() => setTab(t)}>
            <Icon name={t} />
            {t[0]!.toUpperCase() + t.slice(1)}
          </button>
        ))}
      </nav>
    </div>
  );
}

interface Ctx {
  secrets: core.Secrets;
  net: core.Network;
  snap: core.Snapshot | null;
  price: number | null;
  reload: () => Promise<void>;
  settings: Settings;
  saveSettings: (p: Partial<Settings>) => Promise<void>;
}

/** Opening Swap, Bridge or Receive ETH is the user's way of saying they use Ethereum: from then on the home screen and Activity read it too. */
function useEthereumSide(settings: Settings, saveSettings: (p: Partial<Settings>) => Promise<void>) {
  useEffect(() => {
    if (!settings.ethereum) void saveSettings({ ethereum: true });
  }, [settings.ethereum]);
}

/* ----------------------------------------------------------------- Home */

interface Holding {
  key: string;
  name: string;
  where: string;
  /** Dollar value when the asset is not priced in PRL (ETH, WETH). */
  usd?: number;
  amount: string;
  /** Value expressed in PRL; undefined when Keshi has no price for it. */
  prl?: number;
  onClick?: () => void;
}

function Home({ snap, secrets, net, price, loading, error, open, settings, reload, toggleUnit, setTheme, pickWallet, onLock, info, ticker }: Ctx & { info: core.MarketInfo | null; ticker: core.Ticker | null; loading: boolean; error: string; open: (s: Sheet) => void; toggleUnit: () => void; setTheme: (t: "light" | "dark") => void; pickWallet: (i: number) => void; onLock: () => void }) {
  const wallets = core.walletsOf(secrets);
  const active = Math.min(settings.wallet ?? 0, wallets.length - 1);
  const [picking, setPicking] = useState(false);
  const dark = settings.theme === "dark" || (settings.theme === "system" && typeof matchMedia !== "undefined" && matchMedia("(prefers-color-scheme: dark)").matches);
  const hidden = settings.hideBalance;
  const [tokens, setTokens] = useState<core.Token[]>([]);
  const [mine, setMine] = useState<Record<string, bigint>>({});
  const [hold, setHold] = useState<store.EthHoldings | null>(null);
  const [extra, setExtra] = useState<{ meta: core.TokenMeta; balance: bigint | null }[]>([]);
  const [ethUsd, setEthUsd] = useState<number | null>(null);
  /** What could not be read on the last try. Unknown is shown as unknown, never as zero. */
  const [unread, setUnread] = useState<{ tokens: boolean; eth: boolean }>({ tokens: false, eth: false });

  // Another wallet or network: forget the previous one's holdings at once.
  useEffect(() => {
    setMine({});
    setHold(null);
    setExtra([]);
  }, [secrets, net.id]);
  // A refresh keeps what is on screen until the new figures arrive.
  useEffect(() => {
    if (net.id !== "mainnet") return;
    new core.TokenIndex().tokens().then(setTokens).catch(() => {});
    store
      .tokenBalances(secrets, net, snap)
      .then((m) => { setMine(m); setUnread((u) => ({ ...u, tokens: false })); })
      .catch(() => setUnread((u) => ({ ...u, tokens: true })));
    if (!settings.ethereum) return;
    store
      .ethHoldings(secrets)
      .then((h) => { setHold(h); setUnread((u) => ({ ...u, eth: false })); })
      .catch(() => setUnread((u) => ({ ...u, eth: true })));
    store.ethTokenBalances(secrets).then(setExtra).catch(() => {});
    ethUsdNow().then((p) => p && setEthUsd(p));
  }, [secrets, net.id, snap?.updated, settings.ethereum]);

  const rows: Holding[] = [];
  if (snap) rows.push({ key: "prl", name: "PRL", where: "Pearl", amount: formatPrl(snap.balance, 4), prl: prlToNumber(snap.balance), onClick: () => open({ kind: "prl" }) });
  for (const t of tokens) {
    const have = mine[t.ticker] ?? 0n;
    if (have > 0n) rows.push({ key: "t:" + t.ticker, name: t.name, where: "PRL-20 token", amount: bigCompact(have), prl: t.floorGrains ? (t.floorGrains / 1e8) * Number(have) : undefined, onClick: () => open({ kind: "tokens" }) });
  }
  if (hold && hold.wprl > 0n) rows.push({ key: "wprl", name: "wPRL", where: "Ethereum", amount: formatPrl(hold.wprl, 4), prl: prlToNumber(hold.wprl), onClick: () => open({ kind: "asset", asset: "wPRL" }) });
  if (hold && hold.usdt > 0n) rows.push({ key: "usdt", name: "USDT", where: "Ethereum", amount: core.formatUnits(hold.usdt, 6, 2), prl: price ? Number(hold.usdt) / 1e6 / price : undefined });
  // Always listed once the Ethereum side is on, even at zero: it answers "is there any ETH for fees?" at a glance.
  if (hold) rows.push({ key: "eth", name: "ETH", where: "Ethereum, pays Ethereum fees", amount: fmtEth(hold.eth), usd: ethUsd ? (Number(hold.eth) / 1e18) * ethUsd : undefined, onClick: () => open({ kind: "asset", asset: "ETH" }) });
  if (hold && hold.weth > 0n) rows.push({ key: "weth", name: "WETH", where: "Ethereum, wrapped ETH", amount: core.formatEth(hold.weth), usd: ethUsd ? (Number(hold.weth) / 1e18) * ethUsd : undefined });
  for (const x of extra) {
    if (x.balance === null) rows.push({ key: "e:" + x.meta.address, name: x.meta.symbol, where: "Ethereum token · could not be read", amount: "···" });
    else if (x.balance > 0n) rows.push({ key: "e:" + x.meta.address, name: x.meta.symbol, where: "Ethereum token", amount: core.formatUnits(x.balance, x.meta.decimals, 4) });
  }

  const total = rows.reduce((s, r) => s + (r.prl ?? 0), 0);
  const inUsd = settings.unit === "usd" && !!price;
  const prlText = (v: number) => v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: v < 1 ? 6 : 2 });
  const show = (v: number) => (inUsd ? usd(v * price!) : `${prlText(v)} PRL`);
  const main = inUsd ? usd(total * price!) : prlText(total);
  const [whole, frac] = inUsd ? [main, ""] : main.split(".");

  return (
    <>
      <header className="head">
        <Mark size={22} />
        <button className="switcher" onClick={() => setPicking(!picking)} aria-expanded={picking} aria-label="Choose a wallet">
          {wallets[active]?.name ?? "Wallet"}
          <Icon name="down" size={14} />
        </button>
        {net.id === "testnet" && <span className="tag">Testnet</span>}
        <div className="grow" />
        <button className="icon end" onClick={() => setTheme(dark ? "light" : "dark")} aria-label={dark ? "Switch to light mode" : "Switch to dark mode"} title={dark ? "Light mode" : "Dark mode"}>
          <Icon name={dark ? "sun" : "moon"} size={18} />
        </button>
        <button className={`icon end${loading ? " spin" : ""}`} onClick={reload} disabled={loading} aria-label="Refresh" title="Refresh">
          <Icon name="refresh" size={18} />
        </button>
        <button className="icon end" onClick={onLock} aria-label="Lock wallet" title="Lock wallet">
          <Icon name="lock" size={18} />
        </button>
      </header>
      {picking && (
        <ul className="menu pick">
          {wallets.map((w, i) => (
            <li key={i}>
              <button
                className="plain"
                aria-pressed={i === active}
                onClick={() => {
                  setPicking(false);
                  if (i !== active) pickWallet(i);
                }}
              >
                {w.name}
                <small>{i === active ? "In use" : ""}</small>
              </button>
            </li>
          ))}
        </ul>
      )}
      <section className="balance">
        <div className="pearl" aria-hidden="true" />
        <span className="label">Total balance</span>
        <button className="figure" onClick={toggleUnit} title={inUsd ? "Show in PRL" : "Show in dollars"} disabled={!price}>
          {!snap ? (
            <span className="whole dim">···</span>
          ) : hidden ? (
            <span className="whole">••••••</span>
          ) : (
            <>
              <span className="whole">{whole}</span>
              {frac && <span className="frac">.{frac}</span>}
            </>
          )}
          {!inUsd && <span className="unit">PRL</span>}
          {price && snap && !hidden && (
            <span className="flip" aria-hidden="true">
              <Icon name="switch" size={14} />
            </span>
          )}
        </button>
        <p className="fiat">
          {snap && price && !hidden
            ? inUsd
              ? `${prlText(total)} PRL at ${usd(price)} per PRL`
              : `${usd(total * price)} at ${usd(price)} per PRL`
            : snap && !hidden && net.id === "testnet"
              ? "Test coins have no value"
              : " "}
        </p>
        {snap && (snap.pending !== 0n || snap.immature > 0n) && !hidden && (
          <p className="note">
            {snap.pending !== 0n && `${snap.pending > 0n ? "+" : ""}${formatPrl(snap.pending)} confirming`}
            {snap.pending !== 0n && snap.immature > 0n && ", "}
            {snap.immature > 0n && `${formatPrl(snap.immature)} mined, spendable after 100 blocks`}
          </p>
        )}
      </section>
      <div className="quick">
        <button onClick={() => open({ kind: "send" })}>
          <span><Icon name="send" /></span>
          Send
        </button>
        <button onClick={() => open({ kind: "receive" })}>
          <span><Icon name="receive" /></span>
          Receive
        </button>
        <button onClick={() => open({ kind: "trade", side: "buy" })}>
          <span><Icon name="buy" /></span>
          Buy
        </button>
        <button onClick={() => open({ kind: "trade", side: "sell" })}>
          <span><Icon name="sell" /></span>
          Sell
        </button>
      </div>
      {error && <p className="hint">{error}</p>}
      {net.id === "mainnet" && <PriceCard holding={snap ? prlToNumber(snap.balance) : 0} hidden={hidden} info={info} ticker={ticker} />}
      {snap && total === 0 && snap.activity.length === 0 && snap.immature === 0n && (
        <div className="card start">
          <strong>Your wallet is ready</strong>
          <p className="muted">It is empty for now. Receive PRL from someone, from an exchange or from your mining pool, or buy some.</p>
          <div className="actions">
            <button className="btn primary" onClick={() => open({ kind: "receive" })}>
              Receive PRL
            </button>
            <button className="btn" onClick={() => open({ kind: "trade", side: "buy" })}>
              Buy PRL
            </button>
          </div>
        </div>
      )}
      <h3>Your assets</h3>
      {!snap && <Skeleton rows={3} />}
      {snap && (
        <ul className="list holdings">
          {rows.map((r) => {
            const body = (
              <>
                <Coin name={r.name} native={["prl", "wprl", "usdt", "eth", "weth"].includes(r.key)} />
                <span className="main">
                  <span>{r.name}</span>
                  <small>{r.where}</small>
                </span>
                <span className="main end">
                  <span className="amt">{hidden ? "•••" : r.amount}</span>
                  <small>{hidden ? "" : r.usd !== undefined ? usd(r.usd) : r.prl === undefined ? "" : r.key === "prl" && !inUsd ? (price ? usd(r.prl * price) : "") : show(r.prl)}</small>
                </span>
              </>
            );
            return <li key={r.key}>{r.onClick ? <button onClick={r.onClick}>{body}</button> : <div className="row">{body}</div>}</li>;
          })}
        </ul>
      )}
      {snap && net.id === "mainnet" && (unread.tokens || unread.eth) && (
        <p className="hint">
          Could not be read just now: {[unread.tokens ? "PRL-20 token balances" : "", unread.eth ? "Ethereum (ETH, wPRL, USDT)" : ""].filter(Boolean).join(" and ")}.
          {hold || Object.keys(mine).length ? " The figures shown for them are the last ones Keshi read." : " They are not in the total."} Try Refresh in a moment.
        </p>
      )}
      {snap && net.id === "mainnet" && (price || ethUsd) && !hidden && (
        <p className="muted small center">
          {[price ? `PRL at ${usd(price)}` : "", ethUsd ? `ETH at ${usd(ethUsd)}` : ""].filter(Boolean).join(" · ")} · today's prices
        </p>
      )}
      <button className="btn" onClick={() => open({ kind: "tokens" })}>
        Mint or browse PRL-20 tokens
      </button>
    </>
  );
}

/* ------------------------------------------------------------- Activity */

const FLAG: Record<core.Flag, { tag: string; why: string }> = {
  dust: { tag: "Suspicious", why: "A tiny payment you did not ask for. Scammers send these to bait you or to link your addresses. Ignore it." },
  lookalike: { tag: "Suspicious", why: "Sent from an address forged to look like one you use. Never copy an address from this entry." },
};

function ActivityTab({ snap, net, settings, open, secrets, price }: Ctx & { open: (s: Sheet) => void }) {
  const [known, setKnown] = useState<string[]>([]);
  const [own, setOwn] = useState<Set<string>>(new Set());
  const [showAll, setShowAll] = useState(false);
  const [chain, setChain] = useState<"all" | "pearl" | "ethereum">("all");
  const [eth, setEth] = useState<core.EthActivity[] | null>(null);
  const [ethErr, setEthErr] = useState("");
  const [ethUsd, setEthUsd] = useState<number | null>(null);
  useEffect(() => {
    store.knownAddresses(snap).then(setKnown);
    store.ownTxids(net).then(setOwn);
  }, [snap?.updated, net.id]);
  // The Ethereum side of the same recovery phrase, read from Blockscout's public API (mainnet only).
  useEffect(() => {
    setEth(null);
    setEthErr("");
    if (net.id !== "mainnet" || (!settings.ethereum && chain !== "ethereum")) return setEth([]);
    store.ethActivity(secrets).then(setEth).catch((e) => {
      setEth([]);
      setEthErr(errText(e));
    });
    ethUsdNow().then((p) => p && setEthUsd(p));
  }, [secrets, net.id, snap?.updated, settings.ethereum, chain]);
  const flags = useMemo(() => {
    const m: Record<string, core.Flag> = {};
    for (const a of snap?.activity ?? []) {
      const f = core.flagActivity(a, known, own);
      if (f) m[a.txid] = f;
    }
    return m;
  }, [snap?.updated, known, own]);
  const [limit, setLimit] = useState(80);
  const all = snap?.activity.slice(0, limit) ?? null;
  const hiddenCount = all ? all.filter((a) => flags[a.txid]).length : 0;
  const items = all ? (showAll ? all : all.filter((a) => !flags[a.txid])) : null;
  const ethAll = (eth ?? []).slice(0, limit);
  const ethHidden = ethAll.filter((e) => e.flag).length;
  const ethShown = chain === "pearl" ? [] : showAll ? ethAll : ethAll.filter((e) => !e.flag);
  const pearlShown = chain === "ethereum" ? [] : items;
  const ethCount = eth?.length ?? 0;
  const suspicious = (chain === "ethereum" ? 0 : hiddenCount) + (chain === "pearl" ? 0 : ethHidden);
  return (
    <>
      <header className="head">
        <h2>Activity</h2>
      </header>
      {net.id === "mainnet" && (settings.ethereum || ethCount > 0 || chain !== "all") && (
        <div className="seg chains">
          {(["all", "pearl", "ethereum"] as const).map((c) => (
            <button key={c} className={chain === c ? "on" : ""} onClick={() => setChain(c)}>
              {c === "all" ? "All" : c === "pearl" ? "Pearl" : "Ethereum"}
            </button>
          ))}
        </div>
      )}
      {suspicious > 0 && (
        <div className="card">
          <p className="small">
            {suspicious} suspicious payment{suspicious === 1 ? " is" : "s are"} {showAll ? "shown below, marked" : "hidden"}. They are harmless as long as you ignore them.
          </p>
          <button className="link" onClick={() => setShowAll(!showAll)}>
            {showAll ? "Hide suspicious payments" : "Show them"}
          </button>
        </div>
      )}
      {ethErr && chain !== "pearl" && <p className="hint">Ethereum history could not be read right now: {ethErr}. Pearl payments are complete.</p>}
      <ActivityList
        items={pearlShown}
        eth={chain === "pearl" || (eth === null && chain === "all") ? [] : ethShown}
        ethLoading={chain !== "pearl" && eth === null}
        prices={{ prl: price, eth: ethUsd }}
        flags={flags}
        hidden={settings.hideBalance}
        open={open}
        empty={chain === "ethereum" ? "Nothing on Ethereum yet. ETH, wPRL and swaps on your Ethereum address will be listed here." : "Nothing here yet. Payments you send and receive will be listed here."}
      />
      {((snap && snap.activity.length > limit && chain !== "ethereum") || (ethCount > limit && chain !== "pearl")) && (
        <button className="btn" onClick={() => setLimit(limit + 200)}>
          Show older activity
        </button>
      )}
    </>
  );
}

const KIND: Record<core.Activity["kind"], string> = { received: "Received", sent: "Sent", mined: "Block reward", moved: "Moved between your addresses" };

type ActivityRow = { time: number; pearl?: core.Activity; eth?: core.EthActivity };

function ActivityList({ items, eth = [], ethLoading = false, prices = {}, hidden, open, empty, flags = {} }: { items: core.Activity[] | null; eth?: core.EthActivity[]; ethLoading?: boolean; prices?: { prl?: number | null; eth?: number | null }; hidden?: boolean; open: (s: Sheet) => void; empty: string; flags?: Record<string, core.Flag> }) {
  if (!items) return <Skeleton />;
  const rows: ActivityRow[] = [...items.map((a) => ({ time: a.time, pearl: a })), ...eth.map((e) => ({ time: e.time, eth: e }))];
  // Pending first, then newest first. Pearl keeps its own order when times tie.
  rows.sort((a, b) => (b.time || Infinity) - (a.time || Infinity));
  if (!rows.length) return ethLoading ? <Skeleton /> : <p className="muted pad">{empty}</p>;
  const days: { day: string; rows: ActivityRow[] }[] = [];
  for (const r of rows) {
    const day = dayOf(r.time);
    const last = days[days.length - 1];
    if (last && last.day === day) last.rows.push(r);
    else days.push({ day, rows: [r] });
  }
  const glyph = (a: core.Activity) => (flags[a.txid] ? "warn" : a.kind === "mined" ? "mining" : a.kind === "moved" ? "swap" : a.net >= 0n ? "receive" : "send");
  const ethGlyph = (e: core.EthActivity) => (e.kind === "swap" || e.kind === "unwrap" || e.kind === "wrap" || e.kind === "contract" ? "swap" : e.main.amount >= 0n ? "receive" : "send");
  const value = (asset: string, amount: bigint, decimals: number) => {
    const p = asset === "ETH" || asset === "WETH" ? prices.eth : asset === "PRL" || asset === "wPRL" ? prices.prl : asset === "USDT" || asset === "USDC" ? 1 : null;
    return p ? usd((Math.abs(Number(amount)) / 10 ** decimals) * p) : "";
  };
  const leg = (l: core.EthLeg) => `${l.amount >= 0n ? "+" : "−"}${core.formatUnits(l.amount < 0n ? -l.amount : l.amount, l.decimals, l.decimals > 8 ? 5 : 4)} ${l.asset}`;
  return (
    <>
      {days.map((d) => (
        <section className="day" key={d.day}>
          <h4>{d.day}</h4>
          <ul className="list">
            {d.rows.map((r) =>
              r.pearl ? (
                <li key={r.pearl.txid}>
                  <button onClick={() => open({ kind: "tx", tx: r.pearl!, flag: flags[r.pearl!.txid] })}>
                    <span className={`glyph ${flags[r.pearl.txid] ? "bad" : r.pearl.net >= 0n ? "in" : "out"}`} aria-hidden="true">
                      <Icon name={glyph(r.pearl)} size={16} />
                      <Coin name="PRL" native mini />
                    </span>
                    <span className="main">
                      <span>
                        {KIND[r.pearl.kind]}
                        {flags[r.pearl.txid] && <b className="tag warn">{FLAG[flags[r.pearl.txid]!].tag}</b>}
                      </span>
                      <small>
                        {timeOf(r.pearl.time)}
                        {r.pearl.confirmations === 0 ? "" : r.pearl.kind === "mined" && r.pearl.confirmations < 100 ? `, maturing ${r.pearl.confirmations}/100` : ""}
                      </small>
                    </span>
                    <span className="main end">
                      <span className={`amt ${r.pearl.net >= 0n ? "pos" : ""}`}>{hidden ? "•••" : `${r.pearl.net >= 0n ? "+" : ""}${formatPrl(r.pearl.net, 4)} PRL`}</span>
                      {!hidden && <small>{value("PRL", r.pearl.net, 8)}</small>}
                    </span>
                  </button>
                </li>
              ) : (
                <li key={"eth:" + r.eth!.hash}>
                  <button onClick={() => open({ kind: "ethtx", tx: r.eth! })}>
                    <span className={`glyph ${r.eth!.failed || r.eth!.flag ? "bad" : r.eth!.kind === "swap" || r.eth!.kind === "unwrap" || r.eth!.kind === "wrap" ? "" : r.eth!.main.amount >= 0n ? "in" : "out"}`} aria-hidden="true">
                      <Icon name={r.eth!.flag ? "warn" : ethGlyph(r.eth!)} size={16} />
                      <Coin name={r.eth!.main.asset} native={["ETH", "WETH", "wPRL", "USDT"].includes(r.eth!.main.asset)} mini />
                    </span>
                    <span className="main">
                      <span>
                        {r.eth!.flag ? "Unknown token" : r.eth!.kind === "swap" && r.eth!.other ? `Swapped ${r.eth!.main.asset} for ${r.eth!.other.asset}` : core.ETH_KIND_LABEL[r.eth!.kind]}
                        {r.eth!.flag && <b className="tag warn">Suspicious</b>}
                        {r.eth!.failed && <b className="tag warn">Failed</b>}
                      </span>
                      <small>
                        {r.eth!.time ? timeOf(r.eth!.time) : "Waiting for confirmation"}
                        {r.eth!.kind === "swap" ? " · Uniswap" : r.eth!.kind === "bridge-in" || r.eth!.kind === "bridge-out" ? " · PearlBridge" : r.eth!.counterparty ? ` · ${short(r.eth!.counterparty, 6)}` : ""}
                      </small>
                    </span>
                    <span className="main end">
                      <span className={`amt ${r.eth!.main.amount > 0n && !r.eth!.flag ? "pos" : ""}`}>{hidden ? "•••" : r.eth!.kind === "contract" ? "" : leg(r.eth!.main)}</span>
                      {!hidden && !r.eth!.flag && <small>{r.eth!.other ? leg(r.eth!.other) : value(r.eth!.main.asset, r.eth!.main.amount, r.eth!.main.decimals)}</small>}
                    </span>
                  </button>
                </li>
              ),
            )}
          </ul>
        </section>
      ))}
      {ethLoading && <p className="muted small center">Reading your Ethereum address…</p>}
    </>
  );
}

/** One movement on the wallet's Ethereum address. */
function EthTxDetail({ tx, secrets, price, onClose }: Ctx & { tx: core.EthActivity; onClose: () => void }) {
  const [copied, copy] = useCopy();
  const { address } = core.ethAccountOf(secrets);
  const [ethUsd, setEthUsd] = useState<number | null>(null);
  useEffect(() => {
    ethUsdNow().then((p) => p && setEthUsd(p));
  }, []);
  // Value today of a leg, in dollars, when Keshi knows the asset's price.
  const worth = (l: core.EthLeg) => {
    const p = l.asset === "ETH" || l.asset === "WETH" ? ethUsd : l.asset === "PRL" || l.asset === "wPRL" ? price : l.asset === "USDT" || l.asset === "USDC" ? 1 : null;
    return p ? usd((Math.abs(Number(l.amount)) / 10 ** l.decimals) * p) : null;
  };
  const leg = (l: core.EthLeg) => `${l.amount >= 0n ? "+" : "−"}${core.formatUnits(l.amount < 0n ? -l.amount : l.amount, l.decimals, l.decimals > 8 ? 6 : 4)} ${l.asset}`;
  const title = tx.flag ? "Unknown token" : tx.kind === "swap" && tx.other ? `Swapped ${tx.main.asset} for ${tx.other.asset}` : core.ETH_KIND_LABEL[tx.kind];
  return (
    <div className="screen">
      <Header title={title} onBack={onClose} />
      <p className="hero-amt">{tx.kind === "contract" ? "—" : leg(tx.main)}</p>
      {tx.kind !== "contract" && !tx.flag && worth(tx.main) && <p className="muted">{worth(tx.main)} today</p>}
      {tx.flag && (
        <p className="hint warn">
          A token you did not ask for, sent to thousands of addresses at once. Scammers do this to lure you to a website or to make you approve something. It is worth nothing: ignore it, never visit its site and never sign anything for it. It cannot touch your PRL or ETH on its own.
        </p>
      )}
      {tx.failed && <p className="hint warn">This transaction failed on Ethereum. Nothing moved, but the network fee was spent.</p>}
      <dl className="rows">
        <Row k="Status" v={tx.time ? "Confirmed" : "Waiting for confirmation"} />
        {tx.time > 0 && <Row k="Date" v={when(tx.time)} />}
        {tx.other && <Row k={tx.other.amount >= 0n ? "You received" : "You gave"} v={`${leg(tx.other)}${worth(tx.other) ? ` (${worth(tx.other)})` : ""}`} />}
        {tx.kind === "swap" && <Row k="Where" v="Uniswap on Ethereum" />}
        {(tx.kind === "bridge-in" || tx.kind === "bridge-out") && <Row k="Where" v="PearlBridge" />}
        {tx.counterparty && (tx.kind === "received" || tx.kind === "sent") && <Row k={tx.kind === "sent" ? "To" : "From"} v={short(tx.counterparty, 10)} />}
        <Row k="Your Ethereum address" v={short(address, 8)} />
        <Row k="Transaction" v={short(tx.hash, 8)} />
      </dl>
      <p className="muted small">Ethereum movements are read from Blockscout, a public explorer. Keshi keeps no copy of them.</p>
      <div className="grow" />
      <div className="stack">
        <button className="btn" onClick={() => copy(tx.hash)}>
          {copied ? "Copied" : "Copy transaction hash"}
        </button>
        <a className="btn" href={`https://etherscan.io/tx/${tx.hash}`} target="_blank" rel="noreferrer">
          View on Etherscan
        </a>
      </div>
    </div>
  );
}

function TxDetail({ tx, flag, net, price, secrets, snap, reload, onClose }: Ctx & { tx: core.Activity; flag?: core.Flag; onClose: () => void }) {
  const [copied, copy] = useCopy();
  // A payment of ours still waiting: offer to replace it with one paying a higher fee.
  const waiting = tx.confirmations === 0 && tx.net < 0n && (tx.kind === "sent" || tx.kind === "moved");
  const [fast, setFast] = useState<{ plan: core.Plan; oldFee: bigint } | null>(null);
  const [state, setState] = useState<"idle" | "checking" | "sending" | { txid: string }>("idle");
  const [problem, setProblem] = useState("");
  const prepare = async () => {
    if (!snap) return;
    setState("checking");
    setProblem("");
    try {
      const idx = new core.Indexer(net);
      // The first step of a token mint must stay as it is: the second step is already signed against it.
      const mint = await store.pendingReveal(net);
      if (mint?.commitHex && core.txidOfHex(mint.commitHex) === tx.txid) throw new Error("This payment is the first step of a token mint. It cannot be sped up; it will confirm on its own.");
      // Only a payment this device sent can be rebuilt: the record of what the user approved is the reference, not the network's copy.
      const sent = await store.sentRecord(net, tx.txid);
      if (!sent) throw new Error("Keshi can only speed up a payment it sent from this device. This one will confirm when the network is less busy.");
      const [raw, rate] = await Promise.all([idx.tx(tx.txid), idx.feeRate(1)]);
      if ((raw.confirmations ?? 0) > 0) throw new Error("It has just been confirmed: nothing to speed up.");
      // Measured here, not taken from the server.
      const size = core.estimateVsize(raw.vin.length, raw.vout.length);
      const oldRate = Number(BigInt(raw.fees ?? "0") / BigInt(size));
      // At least the fast rate, and clearly above what was paid.
      const plan = core.speedUpPlan(raw, snap, Math.max(rate, Math.ceil(oldRate * 1.5) + 1), sent.inputs && sent.change !== undefined && sent.changeAddress ? { inputs: sent.inputs, change: sent.change, changeAddress: sent.changeAddress } : undefined);
      // The faster payment must pay exactly whom the user paid, exactly as much: a server cannot slip in another recipient.
      if (plan.to !== sent.to || plan.amount.toString() !== sent.amount || (plan.serviceAddress ?? "") !== (sent.serviceAddress ?? "") || plan.serviceFee.toString() !== sent.serviceFee)
        throw new Error("The network's copy of this payment does not match what you sent. Nothing was changed.");
      setFast({ plan, oldFee: BigInt(raw.fees ?? "0") });
      setState("idle");
    } catch (e) {
      setProblem(errText(e));
      setState("idle");
    }
  };
  const confirm = async () => {
    if (!fast || !snap) return;
    setState("sending");
    setProblem("");
    try {
      const txid = await store.pay(secrets, net, snap, fast.plan);
      setState({ txid });
      setFast(null);
      void reload();
    } catch (e) {
      setProblem(errText(e));
      setState("idle");
    }
  };
  return (
    <div className="screen">
      <Header title={KIND[tx.kind]} onBack={onClose} />
      <p className="hero-amt">
        {tx.net >= 0n ? "+" : ""}
        {formatPrl(tx.net)} <small>PRL</small>
      </p>
      {flag && <p className="hint warn">{FLAG[flag].why}</p>}
      <dl className="rows">
        <Row k="Status" v={tx.confirmations === 0 ? "Waiting for confirmation" : `Confirmed (${tx.confirmations} blocks)`} />
        <Row k="Date" v={when(tx.time)} />
        {price && <Row k="Value today" v={usd(Math.abs(prlToNumber(tx.net)) * price)} />}
        {tx.net < 0n && <Row k="Network fee" v={`${formatPrl(tx.fee)} PRL`} />}
        {tx.counterparty && <Row k={tx.kind === "sent" ? "To" : "From"} v={short(tx.counterparty, 10)} />}
        <Row k="Transaction" v={short(tx.txid, 8)} />
      </dl>
      {waiting && typeof state === "object" ? (
        <p className="ok">Sped up. The faster payment replaces this one; it appears in Activity in a moment.</p>
      ) : waiting && !fast ? (
        <div className="card">
          <p className="small">Taking a long time? Keshi can resend it with a higher network fee. The recipient gets exactly the same amount.</p>
          <button className="btn" disabled={state === "checking" || !snap} onClick={prepare}>
            {state === "checking" ? "Checking…" : "Speed up"}
          </button>
          {problem && <p className="hint">{problem}</p>}
        </div>
      ) : waiting && fast ? (
        <div className="card">
          <dl className="rows">
            <Row k="Network fee now" v={`${formatPrl(fast.oldFee)} PRL`} />
            <Row k="Faster network fee" v={`${formatPrl(fast.plan.fee)} PRL`} />
            <Row k="Extra cost" v={`${formatPrl(fast.plan.fee - fast.oldFee)} PRL, from your change`} />
            {net.id === "testnet" && <Row k="Network" v="Pearl testnet (practice coins)" />}
            <Row k="To" v={short(fast.plan.to, 10)} />
            <Row k="Recipient still gets" v={`${formatPrl(fast.plan.amount)} PRL`} />
          </dl>
          <button className="btn primary" disabled={state === "sending"} onClick={confirm}>
            {state === "sending" ? "Sending…" : "Speed up the payment"}
          </button>
          <button className="link" onClick={() => setFast(null)}>
            Cancel
          </button>
          {problem && <p className="error">{problem}</p>}
        </div>
      ) : null}
      <div className="grow" />
      <div className="stack">
        <button className="btn" onClick={() => copy(tx.txid)}>
          {copied ? "Copied" : "Copy transaction ID"}
        </button>
        <a className="btn" href={net.explorerTx.replace("{txid}", tx.txid)} target="_blank" rel="noreferrer">
          View on the Pearl explorer
        </a>
      </div>
    </div>
  );
}

/** "Before → after" for a balance, so the user sees what the screen is about to change. */
const After = ({ from, to, about = false }: { from: string; to: string; about?: boolean }) => (
  <span className="after">
    <s>{from}</s>
    <i aria-hidden="true">→</i>
    <b>{about ? "about " : ""}{to}</b>
  </span>
);
const Row = ({ k, v }: { k: string; v: ReactNode }) => (
  <div>
    <dt>{k}</dt>
    <dd>{v}</dd>
  </div>
);

/* -------------------------------------------------------------- Receive */

function Receive({ snap, secrets, net, reload, onClose, settings, saveSettings }: Ctx & { onClose: () => void }) {
  const fixed = useMemo(() => core.accountOf(secrets, net).derive(false, 0).address, [secrets, net.id]);
  const [mode, setMode] = useState<"fresh" | "mining" | "quantum">("fresh");
  const [pq, setPq] = useState<store.StoredPq | null | undefined>(undefined);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");
  const [onEth, setOnEth] = useState(false);
  const ethAddress = useMemo(() => core.ethAccountOf(secrets).address, [secrets]);
  useEffect(() => {
    if (onEth && !settings.ethereum) void saveSettings({ ethereum: true });
  }, [onEth]);
  useEffect(() => {
    store.quantumAddress(secrets, net).then((p) => setPq(p ?? null));
  }, [secrets, net.id]);
  const address = mode === "quantum" ? (pq?.address ?? "") : mode === "mining" || !snap ? fixed : snap.receive.address;
  const [svg, setSvg] = useState("");
  const [copied, copy] = useCopy();
  useEffect(() => {
    if (!address) return setSvg("");
    QRCode.toString(address.toUpperCase(), { type: "svg", margin: 0, errorCorrectionLevel: "M", color: { dark: "#000000", light: "#ffffff" } }).then(setSvg);
  }, [address]);
  const create = () => {
    setCreating(true);
    setError("");
    // Let "Creating…" appear first: building the post-quantum key keeps the wallet busy for a moment.
    setTimeout(async () => {
      try {
        setPq(await store.createQuantumAddress(secrets, net));
        void reload();
      } catch (e) {
        setError(errText(e));
      } finally {
        setCreating(false);
      }
    }, 50);
  };
  if (onEth)
    return (
      <div className="screen">
        <Header title="Receive on Ethereum" onBack={() => setOnEth(false)} />
        <p className="muted">For wPRL and the ETH that pays Ethereum fees (bridge back to PRL, swaps). It comes from the same recovery phrase as your Pearl wallet.</p>
        <EthAddressCard address={ethAddress} title="Your Ethereum address" />
      </div>
    );
  return (
    <div className="screen">
      <Header title="Receive PRL" onBack={onClose} />
      {address ? (
        <>
          <QrImage svg={svg} />
          <p className="addr-box"><Addr value={address} /></p>
          <button className="btn primary" onClick={() => copy(address)}>
            {copied ? "Copied" : "Copy address"}
          </button>
        </>
      ) : (
        <div className="card start">
          <strong>Quantum-ready address</strong>
          <p className="muted">
            An address with a second way to spend: a post-quantum signature (XMSS) that Pearl already accepts. Create it once; it is derived from your recovery phrase, so the same phrase restores it.
          </p>
          {secrets.key ? (
            <p className="hint">This wallet was imported from a private key. A quantum-ready address needs a recovery phrase.</p>
          ) : (
            <button className="btn primary" disabled={creating || pq === undefined} onClick={create}>
              {creating ? "Creating…" : "Create my quantum-ready address"}
            </button>
          )}
          {error && <p className="error">{error}</p>}
        </div>
      )}
      <div className="seg">
        <button className={mode === "fresh" ? "on" : ""} onClick={() => setMode("fresh")}>
          Fresh address
        </button>
        <button className={mode === "mining" ? "on" : ""} onClick={() => setMode("mining")}>
          Mining address
        </button>
        <button className={mode === "quantum" ? "on" : ""} onClick={() => setMode("quantum")}>
          Quantum-ready
        </button>
      </div>
      <p className="muted small">
        {mode === "mining"
          ? "This address never changes. Use it as the payout address in your mining pool."
          : mode === "quantum"
            ? "Today this address works like any other: you send from it normally. Its post-quantum branch matters if ordinary signatures are ever retired because of quantum computers. It never changes."
            : "A new address appears after each payment, which keeps your payments harder to link. Old addresses keep working."}
      </p>
      <button className="link" onClick={() => setOnEth(true)}>
        Receive ETH or wPRL on Ethereum
      </button>
    </div>
  );
}

/* ----------------------------------------------------------------- Send */

const SPEEDS = [
  { id: "slow", label: "Slow", blocks: 10, note: "about 1 hour" },
  { id: "normal", label: "Normal", blocks: 3, note: "a few blocks" },
  { id: "fast", label: "Fast", blocks: 1, note: "next block" },
] as const;

function Send({ snap, secrets, net, price, reload, preset, onClose, settings }: Ctx & { preset: Extract<Sheet, { kind: "send" }>; onClose: () => void }) {
  const [to, setTo] = useState(preset.to ?? "");
  const [amount, setAmount] = useState(preset.amount ?? "");
  const [max, setMax] = useState(!!preset.max);
  // The amount can be typed in dollars: it is turned into PRL at today's price before anything is built.
  const [unit, setUnit] = useState<"prl" | "usd">(settings.unit === "usd" && price && !preset.amount ? "usd" : "prl");
  const [pasteHint, setPasteHint] = useState("");
  const toRef = useRef<HTMLTextAreaElement>(null);
  const prlAmount = (): bigint | null => {
    if (unit === "prl" || !price) return parsePrl(amount);
    const dollars = Number(amount.replace(",", "."));
    if (!Number.isFinite(dollars) || dollars <= 0) return null;
    return BigInt(Math.round((dollars / price) * 1e8));
  };
  const paste = async () => {
    setPasteHint("");
    try {
      const text = (await navigator.clipboard.readText()).trim();
      if (!text) throw new Error("empty");
      setError("");
      setTo(text.replace(/\s/g, ""));
    } catch {
      // The browser did not hand over the clipboard: the field is ready for a manual paste.
      toRef.current?.focus();
      setPasteHint("Press Ctrl+V (or long-press) to paste the address here.");
    }
  };
  const [speed, setSpeed] = useState<(typeof SPEEDS)[number]["id"]>("normal");
  const [rates, setRates] = useState<Record<string, number>>({});
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [known, setKnown] = useState<string[]>([]);
  const [review, setReview] = useState<core.Plan | null>(null);
  const [ack, setAck] = useState(false);
  const [state, setState] = useState<"edit" | "sending" | { txid: string }>("edit");
  const [error, setError] = useState("");

  useEffect(() => {
    const idx = new core.Indexer(net);
    Promise.all(SPEEDS.map((s) => idx.feeRate(s.blocks))).then((r) => {
      // Faster must never be cheaper than slower.
      const slow = r[0]!, normal = Math.max(r[1]!, slow), fast = Math.max(r[2]!, normal);
      setRates({ slow, normal, fast });
    });
    local.get<Contact[]>("contacts").then((c) => setContacts(c ?? []));
    store.knownAddresses(snap).then(setKnown);
  }, [net.id]);

  const available = snap ? core.spendableTotal(snap) : 0n;
  const feeKind = preset.combine ? "combine" : preset.bridgeTo ? "bridge" : "send";
  const service = core.serviceFor(net, feeKind);
  const rate = rates[speed];

  const prepare = () => {
    setError("");
    if (/^0x[0-9a-fA-F]{40}$/.test(to.trim())) return setError("This is an Ethereum address. To send ETH or wPRL, tap it under Your assets; to move PRL to Ethereum, use the bridge.");
    if (!snap || !rate) return setError("Still loading your wallet. Try again in a moment.");
    try {
      const value = max ? "max" : prlAmount();
      if (value === null) return setError(unit === "usd" ? "Enter an amount in dollars, for example 25" : "Enter an amount in PRL, for example 12.5");
      setReview(core.plan(snap, net, to.trim(), value, rate, service));
    } catch (e) {
      setError(errText(e));
    }
  };

  const confirm = async () => {
    if (!snap || !review) return;
    setState("sending");
    setError("");
    try {
      const txid = await store.pay(secrets, net, snap, review);
      if (preset.bridgeTo) await store.addCrossing({ txid, eth: preset.bridgeTo, amount: review.amount, at: Date.now() });
      setState({ txid });
      reload();
    } catch (e) {
      setError(errText(e));
      setState("edit");
    }
  };

  if (typeof state === "object")
    return (
      <div className="screen">
        <div className="done">
          <div className="pearl" aria-hidden="true" />
          <h2>Sent</h2>
          <p className="muted">
            {preset.bridgeTo
              ? `${formatPrl(review!.amount)} PRL is on its way to the bridge. wPRL is issued on Ethereum once the payment has enough confirmations (6 up to 1,000 PRL, more for larger amounts). Follow it under Bridge.`
              : `${formatPrl(review!.amount)} PRL is on its way to ${short(review!.to)}. It confirms in a few minutes.`}
          </p>
        </div>
        <div className="stack">
          <a className="btn" href={net.explorerTx.replace("{txid}", state.txid)} target="_blank" rel="noreferrer">
            View on the Pearl explorer
          </a>
          <button className="btn primary" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    );

  if (review)
    return (
      <div className="screen">
        <Header title="Review payment" onBack={() => state === "edit" && setReview(null)} />
        <p className="hero-amt">
          {formatPrl(review.amount)} <small>PRL</small>
        </p>
        <dl className="rows">
          {net.id === "testnet" && <Row k="Network" v="Pearl testnet (practice coins)" />}
          <Row k="To" v={<Addr value={review.to} className="mono-wrap addr-in" />} />
          <Row k="Network fee" v={`${formatPrl(review.fee)} PRL`} />
          {review.serviceFee > 0n && <Row k={`Keshi fee (${review.serviceLabel})`} v={`${formatPrl(review.serviceFee)} PRL`} />}
          <Row k="Total leaving your wallet" v={`${formatPrl(review.amount + review.fee + review.serviceFee)} PRL`} />
          {price && <Row k="Value" v={usd(prlToNumber(review.amount) * price)} />}
          {snap && (() => {
            // Coins combined come straight back: only the fees leave.
            const out = preset.combine ? review.fee + review.serviceFee : review.amount + review.fee + review.serviceFee;
            const after = snap.balance - out;
            return <Row k="Your PRL after" v={<After from={`${formatPrl(snap.balance, 4)} PRL`} to={`${formatPrl(after < 0n ? 0n : after)} PRL`} />} />;
          })()}
        </dl>
        {preset.bridgeTo && (
          <p className="hint">
            This is the PearlBridge deposit address for {short(preset.bridgeTo, 6)}. PearlBridge issued it and Keshi cannot verify it: on a first crossing, compare it with the address
            pearlbridge.xyz shows for your Ethereum address, and start small.
          </p>
        )}
        {(() => {
          if (preset.locked || preset.combine) return null;
          const twin = core.lookalikeOf(review.to, known);
          if (twin)
            return (
              <p className="hint warn">
                This address looks like {short(twin, 6)}, which you have used before, but it is a different address. Scammers forge look-alikes. Check every character before sending.
              </p>
            );
          if (!known.includes(review.to)) return <p className="hint">First payment to this address from this wallet.</p>;
          return null;
        })()}
        <p className="muted small">Payments cannot be reversed. Check the address before you send.</p>
        {snap && snap.protectionChecked === false && (
          <label className="check">
            <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
            <span>The token index is unreachable. Coins Keshi already knew carry tokens stay aside, but it cannot check newer ones. I received no token coin larger than 0.0005 PRL since the last check.</span>
          </label>
        )}
        {error && <p className="error">{error}</p>}
        <div className="grow" />
        <button className="btn primary" disabled={state === "sending" || (snap?.protectionChecked === false && !ack)} onClick={confirm}>
          {state === "sending" ? "Sending…" : "Send payment"}
        </button>
      </div>
    );

  return (
    <div className="screen">
      <Header title={preset.title ?? "Send PRL"} onBack={onClose} />
      <label className="field">
        <span>To</span>
        <div className="with-btn">
          <textarea ref={toRef} rows={2} placeholder={`${net.hrp}1…`} spellCheck={false} value={to} readOnly={!!preset.locked} onChange={(e) => {
              setError("");
              setPasteHint("");
              setTo(e.target.value.replace(/\s/g, ""));
            }} />
          {!preset.locked && !to && (
            <button type="button" onClick={paste} aria-label="Paste address">
              Paste
            </button>
          )}
        </div>
        {pasteHint && <small className="muted">{pasteHint}</small>}
      </label>
      {contacts.length > 0 && !to && (
        <div className="chips">
          {contacts.map((c) => (
            <button key={c.address} onClick={() => setTo(c.address)}>
              {c.name}
            </button>
          ))}
        </div>
      )}
      <label className="field">
        <span>
          Amount <em>{formatPrl(available)} PRL available</em>
        </span>
        <div className="with-btn">
          <input
            inputMode="decimal"
            placeholder="0.00"
            value={max ? "Everything" : amount}
            readOnly={max}
            onChange={(e) => setAmount(e.target.value)}
          />
          {price && !max && (
            <button type="button" className="unit" onClick={() => setUnit(unit === "prl" ? "usd" : "prl")} aria-label="Switch between PRL and dollars">
              {unit === "prl" ? "PRL" : "USD"}
            </button>
          )}
          <button
            className={max ? "on" : ""}
            onClick={() => {
              setMax(!max);
              setAmount("");
            }}
          >
            Max
          </button>
        </div>
      </label>
      {price && !max && prlAmount() ? <p className="muted small">{unit === "usd" ? `${formatPrl(prlAmount()!)} PRL at today's price` : usd(prlToNumber(prlAmount()!) * price)}</p> : null}
      <div className="field">
        <span>Speed</span>
        <div className="seg">
          {SPEEDS.map((s) => (
            <button key={s.id} className={speed === s.id ? "on" : ""} onClick={() => setSpeed(s.id)}>
              {s.label}
              <small>{s.note}</small>
              {rates[s.id] && price ? <small>{usd(prlToNumber(BigInt(rates[s.id]! * 154)) * price)}</small> : null}
            </button>
          ))}
        </div>
        {rate && (
          <p className="muted small">
            Network fee: about {formatPrl(BigInt(rate * 154), 8).replace(/0+$/, "").replace(/\.$/, "")} PRL for a typical payment. It goes to Pearl miners, not to Keshi.
          </p>
        )}
      </div>
      {snap && snap.protectionChecked === false && (
        <p className="hint">The token index is unreachable. Coins Keshi already knew carry tokens stay aside, and coins of 0.0005 PRL or less are left untouched; if you received larger token coins since the last check, wait before sending.</p>
      )}
      {service && (
        <p className="muted small">
          Keshi fee: {service.label} of the amount, never more than {formatPrl(service.cap)} PRL. You see the exact figure before you confirm.
        </p>
      )}
      {error && <p className="error">{error}</p>}
      <div className="grow" />
      <button className="btn primary" disabled={!to || (!max && !amount)} onClick={prepare}>
        Review
      </button>
    </div>
  );
}

/* ---------------------------------------------------------------- Trade */

const HOME_PERIODS = [
  { id: "24H", days: 1, minutes: 15, limit: 96 },
  { id: "7D", days: 7, minutes: 120, limit: 84 },
  { id: "30D", days: 30, minutes: 360, limit: 120 },
  { id: "90D", days: 90, minutes: 1440, limit: 90 },
] as const;

/**
 * PRL price over a period: SafeTrade first, then BigONE, then CoinGecko. The last
 * good series is remembered, so a feed that is briefly down never empties the chart.
 */
const lastSeries = new Map<string, core.Point[]>();
async function priceSeries(p: { id: string; days: number; minutes: number; limit: number }, quote: "usdt" | "usdc" = "usdt"): Promise<{ pts: core.Point[]; src: "exchange" | "coingecko" }> {
  const enough = (pts: core.Point[]) => {
    if (pts.length < 2) throw new Error("empty");
    return pts;
  };
  const key = `${quote}:${p.id}`;
  try {
    const r = await new core.Exchange(undefined, undefined, quote)
      .candles(p.minutes, p.limit)
      .then((c) => enough(c.map((k) => ({ time: k.time, value: k.close }))))
      .then((pts) => ({ pts, src: "exchange" as const }))
      .catch(() => new core.BigOne().candles(p.minutes, p.limit).then((c) => ({ pts: enough(c.map((k) => ({ time: k.time, value: k.close }))), src: "exchange" as const })))
      .catch(() => new core.MarketData().history(p.days).then((h) => ({ pts: enough(h.prices), src: "coingecko" as const })));
    lastSeries.set(key, r.pts);
    return r;
  } catch (e) {
    const kept = lastSeries.get(key);
    if (kept) return { pts: kept, src: "exchange" };
    throw e;
  }
}

/** The PRL price over a chosen period, with how much it moved. Shown on the home screen. */
function PriceCard({ holding, hidden, info, ticker }: { holding: number; hidden: boolean; info: core.MarketInfo | null; ticker: core.Ticker | null }) {
  // Market cap from the live price and the supply in circulation, like the exchanges show it.
  const cap = info ? (ticker && info.supply ? ticker.last * info.supply : info.marketCap) : null;
  const [period, setPeriod] = useState<(typeof HOME_PERIODS)[number]["id"]>("24H");
  const [points, setPoints] = useState<core.Point[] | null>(null);
  useEffect(() => {
    let alive = true;
    setPoints(null);
    const p = HOME_PERIODS.find((x) => x.id === period)!;
    priceSeries(p)
      .then((r) => alive && setPoints(r.pts))
      .catch(() => alive && setPoints([]));
    return () => {
      alive = false;
    };
  }, [period]);
  const first = points?.[0]?.value, last = points?.[points.length - 1]?.value;
  const move = first && last ? (last - first) / first : null;
  return (
    <section className="pricecard">
      <div className="row-head">
        <h3>PRL price</h3>
        {move !== null && (
          <span className={`delta ${move >= 0 ? "up" : "dn"}`}>
            {move >= 0 ? "+" : ""}
            {(move * 100).toFixed(2)}%{!hidden && holding > 0 && first && last ? ` (${move >= 0 ? "+" : "-"}${usd(Math.abs(holding * (last - first)))})` : ""}
          </span>
        )}
      </div>
      <Chart points={points} format={(v) => usd(v)} label="PRL price in dollars" />
      <div className="periods wide">
        {HOME_PERIODS.map((p) => (
          <button key={p.id} className={period === p.id ? "on" : ""} onClick={() => setPeriod(p.id)}>
            {p.id}
          </button>
        ))}
      </div>
      <div className="stats">
        <div>
          <span className="muted small">Market cap</span>
          <strong>{cap ? usdCompact(cap) : "—"}</strong>
        </div>
        <div>
          <span className="muted small">24h volume</span>
          <strong>{info ? usdCompact(info.volume24h) : "—"}</strong>
        </div>
        <div>
          <span className="muted small">In circulation</span>
          <strong>{info ? compact(info.supply) : "—"}</strong>
        </div>
      </div>
    </section>
  );
}

/** Single-series line chart with a crosshair readout. */
function Chart({ points, format, label }: { points: core.Point[] | null; format: (v: number) => string; label: string }) {
  const [hover, setHover] = useState<number | null>(null);
  if (!points) return <div className="chart empty">Loading chart…</div>;
  if (points.length < 2) return <div className="chart empty">No chart data for this period.</div>;
  const values = points.map((p) => p.value);
  const min = Math.min(...values), max = Math.max(...values), span = max - min || 1;
  const x = (i: number) => (i / (points.length - 1)) * 100;
  const y = (v: number) => 6 + (1 - (v - min) / span) * 88;
  const line = points.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(2)} ${y(p.value).toFixed(2)}`).join("");
  const first = points[0]!, last = points[points.length - 1]!;
  const shown = hover === null ? last : points[hover]!;
  const move = (e: React.PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const f = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    setHover(Math.round(f * (points.length - 1)));
  };
  const stamp = (t: number) => new Date(t * 1000).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  return (
    <figure className="chart" aria-label={`${label} from ${stamp(first.time)} to ${stamp(last.time)}. Low ${format(min)}, high ${format(max)}, latest ${format(last.value)}.`}>
      <figcaption>
        <strong>{format(shown.value)}</strong>
        <span>{hover === null ? `Low ${format(min)}, high ${format(max)}` : stamp(shown.time)}</span>
      </figcaption>
      <div className="plot" onPointerMove={move} onPointerDown={move} onPointerLeave={() => setHover(null)}>
        <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
          <path d={`${line}L100 100L0 100Z`} className="area" />
          <path d={line} className="line" vectorEffect="non-scaling-stroke" />
        </svg>
        {hover !== null && (
          <>
            <i className="cross" style={{ left: `${x(hover)}%` }} />
            <i className="pt" style={{ left: `${x(hover)}%`, top: `${y(shown.value)}%` }} />
          </>
        )}
      </div>
      <div className="axis">
        <span>{stamp(first.time)}</span>
        <span>{stamp(last.time)}</span>
      </div>
    </figure>
  );
}

/* ----------------------------------------------------------------- Swap */

const WPRL_META: core.TokenMeta = { address: core.WPRL_CONTRACT, symbol: "wPRL", decimals: 8 };

// The only token wPRL is swapped with. ETH is plain ether: Keshi wraps and
// unwraps it inside the swap, so the user never sees WETH.
const ETH_META: core.TokenMeta = { address: core.WETH, symbol: "ETH", decimals: 18 };

/** Shown when Ethereum fees are large next to the amount swapped. Never blocks. */
function SmallSwap({ valueUsd, costUsd }: { valueUsd: number | null; costUsd: number | null }) {
  const w = core.smallSwap(valueUsd, costUsd);
  if (!w) return null;
  return (
    <p className="hint warn">
      {w.costUsd !== null
        ? `Ethereum fees are about ${usd(w.costUsd)} right now, around ${Math.min(999, Math.round(w.share! * 100))}% of this swap. Small swaps are rarely worth it.`
        : "Ethereum fees are the same for small and large swaps, often a few dollars. Under $50, a swap is rarely worth it."}
    </p>
  );
}

function Swap({ secrets, net, price: prlUsd, open, settings, saveSettings }: Ctx & { open: (s: Sheet) => void }) {
  useEthereumSide(settings, saveSettings);
  // Keshi swaps wPRL and ETH only: the user sends and receives plain ETH (WETH is handled inside the swap).
  const [dir, setDir] = useState<"buy" | "sell">("buy"); // buy: wPRL -> ETH, sell: ETH -> wPRL
  const [showEth, setShowEth] = useState(false);
  const [amount, setAmount] = useState("");
  const [route, setRoute] = useState<core.Route | null>(null);
  const [hold, setHold] = useState<store.EthHoldings | null>(null);
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState("");
  const [error, setError] = useState("");
  const [done, setDone] = useState("");
  const fee = core.swapFee();
  const [costUsd, setCostUsd] = useState<number | null>(null);
  const [ethNeed, setEthNeed] = useState<bigint | null>(null);
  useEffect(() => {
    if (net.id !== "mainnet") return;
    // Both read today's Ethereum gas price: what a swap costs now, and what to keep in case it rises.
    const rpc = new core.EthRpc();
    core.swapCostUsd(rpc).then(setCostUsd);
    core.swapEthNeeded(rpc).then(setEthNeed);
  }, [net.id]);
  const reserve = ethNeed ?? core.MIN_ETH_FOR_FEES;
  const reserveText = `${core.formatEth(reserve + 99_999_999_999_999n, 4)} ETH`;
  const lowEth = !!hold && hold.eth < reserve;

  const [holdFailed, setHoldFailed] = useState(false);
  const refresh = useCallback(() => {
    store.ethHoldings(secrets).then((h) => { setHold(h); setHoldFailed(false); }).catch(() => setHoldFailed(true));
  }, [secrets]);
  useEffect(refresh, [refresh]);
  // The first reading of the Ethereum address picks the direction that makes sense:
  // ETH but no wPRL -> ETH to wPRL. After that the user is in charge.
  const aimed = useRef(false);
  useEffect(() => {
    if (!hold || aimed.current) return;
    aimed.current = true;
    if (hold.wprl === 0n && hold.eth > 0n) setDir("sell");
  }, [hold]);
  // Nothing on Ethereum at all: no form, just the two ways to get started.
  const nothingOnEth = !!hold && hold.wprl === 0n && hold.weth === 0n && hold.eth === 0n;
  const noEthForFee = !!hold && hold.eth === 0n;

  const isEth = true;
  const unwrap = async () => {
    if (!hold || hold.weth <= 0n) return;
    setBusy(true);
    setError("");
    setDone("");
    try {
      setStep("Turning WETH into ETH…");
      await store.unwrapWeth(secrets, hold.weth);
      setDone(`${core.formatUnits(hold.weth, 18)} WETH is now ETH on your Ethereum address.`);
      refresh();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
      setStep("");
    }
  };
  const meta = ETH_META;
  const metaBal = hold?.eth ?? null;
  const give = dir === "buy" ? WPRL_META : meta;
  const get = dir === "buy" ? meta : WPRL_META;
  const giveBal = dir === "buy" ? (hold?.wprl ?? null) : metaBal;

  const price = async () => {
    if (!give || !get) return;
    setError("");
    setDone("");
    setRoute(null);
    const value = core.parseUnits(amount, give.decimals);
    if (value === null || value <= 0n) return setError("Enter an amount, for example 100");
    // Paying in ETH: the Ethereum fee comes out of the same ETH, so some must stay behind.
    if (isEth && dir === "sell" && hold) {
      const room = hold.eth > reserve ? hold.eth - reserve : 0n;
      if (value > room) return setError(`Keep about ${reserveText} for the Ethereum fee. You can swap up to ${core.formatEth(room, 5)} ETH.`);
    }
    setBusy(true);
    try {
      setRoute(await core.findRoute(new core.EthRpc(), give.address, get.address, value));
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };

  const go = async () => {
    if (!route || !give || !get || !meta) return;
    setBusy(true);
    setError("");
    try {
      await store.swap(secrets, route, setStep, isEth);
      setDone(`Swapped ${core.formatUnits(route.amountIn, give.decimals)} ${give.symbol} for ${get.symbol}. It is on your Ethereum address.`);
      setRoute(null);
      setAmount("");
      refresh();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
      setStep("");
    }
  };

  if (net.id !== "mainnet")
    return (
      <>
        <header className="head">
          <h2>Swap</h2>
        </header>
        <p className="muted pad">Swaps only work on Pearl mainnet.</p>
      </>
    );

  const received = route ? (fee ? route.amountOut - (route.amountOut * fee.bips) / 10_000n : route.amountOut) : 0n;
  const short_ = give && giveBal !== null && route ? giveBal < route.amountIn : false;

  return (
    <>
      <header className="head">
        <h2>Swap</h2>
        <div className="grow" />
        <span className="muted small">Uniswap on Ethereum</span>
      </header>
      <p className="muted small">Swap wPRL and ETH, in both directions. You send and receive plain ETH: Keshi takes care of WETH for you.</p>
      {!hold && !holdFailed && <p className="muted small">Reading your Ethereum address…</p>}
      {nothingOnEth && (
        <>
          <div className="card start">
            <strong>Nothing on Ethereum yet</strong>
            <p className="muted small">Swapping happens on Ethereum. To start, bring some PRL over as wPRL, or receive ETH on your Ethereum address.</p>
            <div className="paths">
              <button className="path" onClick={() => open({ kind: "bridge" })}>
                <Coin name="PRL" native />
                <span className="text">
                  <b>Bridge PRL to wPRL</b>
                  <small>Uses your PRL. No ETH needed.</small>
                </span>
                <Icon name="chevron" />
              </button>
              <button className={`path${showEth ? " on" : ""}`} onClick={() => setShowEth((v) => !v)}>
                <Coin name="ETH" native />
                <span className="text">
                  <b>Receive ETH</b>
                  <small>{costUsd ? `Right now one swap costs about ${usd(costUsd)}. Keep about ${reserveText} for fees.` : "Show your Ethereum address."}</small>
                </span>
                <Icon name="chevron" />
              </button>
            </div>
          </div>
          {showEth && <EthAddressCard address={hold!.address} />}
          <p className="muted small">Your Ethereum address comes from the same recovery phrase as your Pearl wallet. Nothing to set up.</p>
        </>
      )}
      {hold && hold.weth > 0n && (
        <div className="card">
          <p>
            You have <b>{core.formatUnits(hold.weth, 18)} WETH</b>, wrapped ETH. Turn it into plain ETH to use it for fees or swaps.
          </p>
          <button className="btn" disabled={busy || hold.eth === 0n} onClick={unwrap}>
            {busy && step.startsWith("Turning") ? "Working…" : "Turn WETH into ETH"}
          </button>
        </div>
      )}
      {meta && (hold || holdFailed) && !nothingOnEth && (
        <>
          {hold && hold.wprl > 0n && dir === "buy" && (
            <p className="status ok">
              <b>{formatPrl(hold.wprl)} wPRL</b> on your Ethereum address. Ready to swap.
            </p>
          )}
          {hold && hold.wprl === 0n && hold.eth > 0n && dir === "sell" && (
            <p className="status ok">
              You hold <b>{core.formatEth(hold.eth)} ETH</b> and no wPRL yet, so Keshi starts with ETH to wPRL. Switch any time.
            </p>
          )}
          {hold && hold.wprl === 0n && dir === "buy" && (
            <div className="card">
              <p>
                <b>You have no wPRL yet.</b> wPRL is your PRL on Ethereum. Get it with the bridge, a step that needs no ETH, or buy some with ETH: choose ETH to wPRL.
              </p>
              <button className="btn primary" onClick={() => open({ kind: "bridge" })}>
                Bridge PRL to wPRL
              </button>
            </div>
          )}
          <div className="seg">
            <button
              className={dir === "buy" ? "on" : ""}
              onClick={() => {
                setDir("buy");
                setRoute(null);
              }}
            >
              wPRL to {meta.symbol}
            </button>
            <button
              className={dir === "sell" ? "on" : ""}
              onClick={() => {
                setDir("sell");
                setRoute(null);
              }}
            >
              {meta.symbol} to wPRL
            </button>
          </div>
          <label className="field">
            <span>
              You give <em>{give && giveBal !== null ? `${core.formatUnits(giveBal, give.decimals)} ${give.symbol} available` : ""}</em>
            </span>
            <input
              inputMode="decimal"
              placeholder="0.00"
              value={amount}
              onChange={(e) => {
                setAmount(e.target.value);
                setRoute(null);
              }}
            />
          </label>
          {route && get && (
            <dl className="rows">
              <Row k="You receive about" v={`${core.formatUnits(received, get.decimals)} ${get.symbol}`} />
              <Row k="You give" v={`${core.formatUnits(route.amountIn, give!.decimals)} ${give!.symbol}`} />
              <Row k="Ethereum fee" v={costUsd ? `about ${usd(costUsd)}, paid in ETH` : "Paid in ETH"} />
              {hold && (() => {
                const wprlAfter = dir === "buy" ? hold.wprl - route.amountIn : hold.wprl + received;
                const ethAfter = dir === "buy" ? hold.eth + received : hold.eth - route.amountIn;
                return (
                  <>
                    <Row k="Your wPRL after" v={<After from={`${formatPrl(hold.wprl, 4)} wPRL`} to={`${formatPrl(wprlAfter < 0n ? 0n : wprlAfter, 4)} wPRL`} about={dir === "sell"} />} />
                    <Row k="Your ETH after" v={<After from={`${fmtEth(hold.eth)} ETH`} to={`${fmtEth(ethAfter < 0n ? 0n : ethAfter)} ETH, minus the fee`} about />} />
                  </>
                );
              })()}
            </dl>
          )}
          {route && get && fee && <p className="muted small">Quote includes a {fee.label} Keshi fee.</p>}
          {route && <SmallSwap valueUsd={prlUsd ? (Number(dir === "buy" ? route.amountIn : received) / 1e8) * prlUsd : null} costUsd={costUsd} />}
          {route && short_ && dir === "buy" && (
            <div className="card">
              <p>Swaps start from wPRL. You have {hold ? formatPrl(hold.wprl) : "0.00"} wPRL: turn PRL into wPRL with the bridge first.</p>
              <button className="btn primary" onClick={() => open({ kind: "bridge" })}>
                Bridge PRL to wPRL
              </button>
            </div>
          )}
          {route && short_ && dir === "sell" && <p className="error">You do not hold that much {give?.symbol}.</p>}
          {noEthForFee && dir === "buy" && (
            <GetEth
              address={hold!.address}
              lead={
                <>
                  You have no ETH for the Ethereum fee{costUsd ? ` (about ${usd(costUsd)})` : ""}. Receive a little ETH first, then swap. Keep about <b>{reserveText}</b>, a margin in case fees rise.
                </>
              }
            />
          )}
          {lowEth && !noEthForFee && (
            <div className="hint">
              <p>
                Every swap is an Ethereum transaction, paid in ETH.{costUsd ? ` Right now one swap costs about ${usd(costUsd)}.` : ""} Keep about <b>{reserveText}</b> on your Ethereum address in Keshi, a margin in case fees rise. You have {core.formatEth(hold!.eth)} ETH.
              </p>
              {!showEth && (
                <button className="link" onClick={() => setShowEth(true)}>
                  Show my Ethereum address
                </button>
              )}
            </div>
          )}
          {lowEth && !noEthForFee && showEth && <EthAddressCard address={hold!.address} />}
          {step && <p className="muted small">{step}</p>}
          {error && <p className="error">{error}</p>}
          {done && <p className="ok">{done}</p>}
          {!route ? (
            <button className="btn primary" disabled={busy || !amount || (noEthForFee && dir === "buy")} onClick={price}>
              {busy ? "Getting the price…" : "Get the price"}
            </button>
          ) : (
            <button className="btn primary" disabled={busy || short_ || !hold || hold.eth === 0n} onClick={go}>
              {busy ? "Working…" : `Swap for ${get?.symbol}`}
            </button>
          )}
          <p className="muted small">
            The swap is cancelled if the price moves more than 1% against you, or if it is not confirmed within 20 minutes.
          </p>
          <p className="muted small">Uniswap pool fees and Ethereum network fees are set by those networks, not by Keshi. On a small amount they can be a large share of the swap: check the quote before you confirm. A confirmed swap cannot be reversed.</p>
        </>
      )}
      {!meta && error && <p className="error">{error}</p>}
      {net.id === "mainnet" && !nothingOnEth && (
        <button className="btn" onClick={() => open({ kind: "bridge" })}>
          Bridge PRL and wPRL
        </button>
      )}
    </>
  );
}

/* -------------------------------------------------------------- Explore */

const MOOD_LABEL: Record<core.Mood, string> = { bullish: "Bullish", bearish: "Bearish", neutral: "Neutral" };
const ago = (t: number) => {
  if (!t) return "";
  const m = Math.max(0, Math.round((Date.now() / 1000 - t) / 60));
  if (m < 60) return `${Math.max(1, m)} min ago`;
  if (m < 48 * 60) return `${Math.round(m / 60)} h ago`;
  return `${Math.round(m / 1440)} days ago`;
};

/** Pearl news, newest first, each story once, marked bullish (green) or bearish (red). */
const TOPIC_LABEL: Record<core.Topic, string> = { prl: "Pearl", eth: "Ethereum" };

function Explore() {
  const [items, setItems] = useState<core.NewsItem[] | null>(null);
  const [updated, setUpdated] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [topic, setTopic] = useState<"all" | core.Topic>("prl");
  const [mood, setMood] = useState<"all" | core.Mood>("all");
  const [read, setRead] = useState<string[]>([]);
  const [since, setSince] = useState<number | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const list = await core.loadNews();
      setItems(list);
      setUpdated(Date.now());
      await local.set("newsCache", { at: Date.now(), items: list });
    } catch (e) {
      setError(errText(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    (async () => {
      // "New" means published since the previous visit to this tab.
      const visit = (await local.get<number>("newsVisit")) ?? 0;
      setSince(visit);
      await local.set("newsVisit", Math.floor(Date.now() / 1000));
      setRead((await local.get<string[]>("newsRead").catch(() => undefined)) ?? []);
      const cache = await local.get<{ at: number; items: core.NewsItem[] }>("newsCache");
      // A cache written by an older version (no topic on its stories) is read again from the sources.
      const usable = cache?.items?.every((n) => n.topic === "prl" || n.topic === "eth") ? cache : undefined;
      if (usable) {
        setItems(usable.items);
        setUpdated(usable.at);
      }
      if (!usable || Date.now() - usable.at > 5 * 60_000) void refresh();
    })();
    const id = setInterval(() => void refresh(), 10 * 60_000);
    return () => clearInterval(id);
  }, [refresh]);

  const markRead = (id: string) => {
    if (read.includes(id)) return;
    const next = [id, ...read].slice(0, 400);
    setRead(next);
    void local.set("newsRead", next).catch(() => {});
  };

  const inTopic = (items ?? []).filter((n) => topic === "all" || n.topic === topic);
  const shown = inTopic.filter((n) => mood === "all" || n.mood === mood);
  const count = (m: core.Mood) => inTopic.filter((n) => n.mood === m).length;
  const topicCount = (t: "all" | core.Topic) => (items ?? []).filter((n) => t === "all" || n.topic === t).length;
  const pickMood = (m: core.Mood) => setMood(mood === m ? "all" : m);
  const empty =
    mood !== "all"
      ? `No ${mood} ${topic === "all" ? "" : `${TOPIC_LABEL[topic]} `}news right now.`
      : topic === "prl"
        ? `No Pearl news in the last ${core.NEWS_LIMITS.prl.days} days.`
        : topic === "eth"
          ? `No major Ethereum news in the last ${core.NEWS_LIMITS.eth.days} days.`
          : "No news right now.";

  return (
    <>
      <header className="head">
        <h2>Explore</h2>
        <div className="grow" />
        <button className="link" onClick={() => void refresh()} disabled={loading}>
          {loading ? "Updating…" : "Refresh"}
        </button>
      </header>
      <p className="muted small">Pearl and Ethereum news from the largest crypto newsrooms, newest first. Each story appears once, even when many sites carry it.</p>
      <div className="seg topics">
        {(["prl", "eth", "all"] as const).map((t) => (
          <button key={t} className={topic === t ? "on" : ""} onClick={() => setTopic(t)}>
            {t === "all" ? "All" : TOPIC_LABEL[t]} {items ? <small>{topicCount(t)}</small> : null}
          </button>
        ))}
      </div>
      <div className="chips news-moods" role="group" aria-label="Show only">
        <button className={`up${mood === "bullish" ? " on" : ""}`} aria-pressed={mood === "bullish"} onClick={() => pickMood("bullish")}>
          Bullish {items ? <small>{count("bullish")}</small> : null}
        </button>
        <button className={`down${mood === "bearish" ? " on" : ""}`} aria-pressed={mood === "bearish"} onClick={() => pickMood("bearish")}>
          Bearish {items ? <small>{count("bearish")}</small> : null}
        </button>
      </div>
      {error && !items?.length && <p className="error">{error}</p>}
      {items === null ? (
        <p className="muted">Reading the news…</p>
      ) : shown.length === 0 ? (
        <p className="muted">{empty}</p>
      ) : (
        <ul className="news">
          {shown.map((n) => {
            const isNew = since !== null && since > 0 && n.time > since && !read.includes(n.id);
            return (
              <li key={n.id} className={`${n.mood}${read.includes(n.id) ? " read" : ""}`}>
                <a href={n.url} target="_blank" rel="noreferrer noopener" onClick={() => markRead(n.id)}>
                  <span className="meta">
                    <b className={`mood ${n.mood}`}>{MOOD_LABEL[n.mood]}</b>
                    {topic === "all" && <b className="topic">{n.topic === "prl" ? "PRL" : "ETH"}</b>}
                    {isNew && <b className="tag new">New</b>}
                    <span>
                      {n.source}
                      {(() => {
                        // The site the link really opens, when its name does not say so: a feed cannot hide a strange destination behind a familiar outlet name.
                        try {
                          const host = new URL(n.url).hostname.replace(/^www\./, "");
                          return host.includes(n.source.toLowerCase().replace(/[^a-z0-9]/g, "")) ? "" : ` · ${host}`;
                        } catch {
                          return "";
                        }
                      })()}
                      {n.time ? ` · ${ago(n.time)}` : ""}
                    </span>
                  </span>
                  <strong>{n.title}</strong>
                  {n.alsoIn.length > 0 && <small className="muted">Also on {n.alsoIn.slice(0, 3).join(", ")}{n.alsoIn.length > 3 ? ` and ${n.alsoIn.length - 3} more` : ""}</small>}
                </a>
              </li>
            );
          })}
        </ul>
      )}
      <p className="muted small">
        Ethereum shows only its important stories: hacks, upgrades, ETFs, big price moves. Bullish or bearish is read from each headline's words: a quick guide, not advice.{" "}
        {updated ? `Updated ${ago(Math.floor(updated / 1000))}.` : ""}
      </p>
    </>
  );
}

/* ----------------------------------------------------------- Buy / Sell */

type Venue = "bigone" | "safetrade" | "uniswap";
const VENUE: Record<Venue, { name: string; how: string; site?: string }> = {
  bigone: { name: "BigONE", how: "Exchange. Largest PRL market.", site: "https://big.one" },
  safetrade: { name: "SafeTrade", how: "Exchange.", site: "https://safe.trade" },
  uniswap: { name: "Uniswap", how: "No account needed. Pays in ETH on Ethereum." },
};

function TradeSheet({ side, secrets, setSecrets, net, snap, price, reload, open, onClose, settings, saveSettings }: Ctx & { side: "buy" | "sell"; setSecrets: (s: core.Secrets) => void; open: (s: Sheet) => void; onClose: () => void }) {
  const [amount, setAmount] = useState("");
  // Buying has two ways in: USDT already held on another chain, or an exchange.
  const [pay, setPay] = useState<"usdt" | "exchange">("exchange");
  const [venue, setVenue] = useState<Venue | null>(null);
  const [prices, setPrices] = useState<Partial<Record<Venue, number>>>({});
  /** Venues whose order book cannot fill the amount: how much they can take. */
  const [thin, setThin] = useState<Partial<Record<Venue, number>>>({});
  // Uniswap trades in ETH: buying is an exact amount of wPRL paid in ETH, selling is wPRL turned into ETH.
  const [uniBuy, setUniBuy] = useState<core.EthBuy | null>(null);
  const [uniSell, setUniSell] = useState<core.Route | null>(null);
  const [ethUsd, setEthUsd] = useState<number | null>(null);
  const uniFee = core.swapFee();
  const [uniCost, setUniCost] = useState<number | null>(null);
  const [ethNeed, setEthNeed] = useState<bigint | null>(null);
  useEffect(() => {
    if (net.id !== "mainnet") return;
    core.swapCostUsd(new core.EthRpc()).then(setUniCost);
    core.swapEthNeeded(new core.EthRpc()).then(setEthNeed);
  }, [net.id]);
  const uniKeep = 1 - Number(uniFee?.bips ?? 0n) / 10_000;
  const [loading, setLoading] = useState(false);
  const [hold, setHold] = useState<store.EthHoldings | null>(null);
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState("");
  const [error, setError] = useState("");
  const [done, setDone] = useState("");
  const [copied, copy] = useCopy();

  const grains = parsePrl(amount);
  const qty = grains ? prlToNumber(grains) : 0;

  useEffect(() => {
    if (settings.ethereum) store.ethHoldings(secrets).then(setHold).catch(() => {});
  }, [secrets.phrase, secrets.key, secrets.account, done]);

  // Live prices for the amount typed, from the three places PRL trades.
  useEffect(() => {
    setError("");
    setDone("");
    if (!grains || grains <= 0n) {
      setPrices({});
      setUniBuy(null);
      setUniSell(null);
      return;
    }
    let alive = true;
    setLoading(true);
    const timer = setTimeout(async () => {
      const rpc = new core.EthRpc();
      const [bo, stb, uq, eu] = await Promise.allSettled([
        // A deep book for the walk; should a venue refuse the depth asked, its shallow book still gives a price.
        new core.BigOne().book(50).catch(() => new core.BigOne().book(5)),
        new core.Exchange(undefined, undefined, "usdt").book(50).catch(() => new core.Exchange(undefined, undefined, "usdt").book(12)),
        side === "buy" ? core.ethBuyQuote(rpc, grains) : core.findRoute(rpc, core.WPRL_CONTRACT, core.WETH, grains),
        core.ethUsdOnUniswap(rpc),
      ]);
      if (!alive) return;
      const p: Partial<Record<Venue, number>> = {};
      const d: Partial<Record<Venue, number>> = {};
      // The exchanges: walk the book for this amount, not just its top line, so "best" means best for this size.
      for (const [v, book] of [["bigone", bo], ["safetrade", stb]] as const) {
        if (book.status !== "fulfilled") continue;
        const walk = core.walkBook(side === "buy" ? book.value.asks : book.value.bids, prlToNumber(grains));
        if (walk.filled > 0) {
          p[v] = walk.avg;
          if (!walk.enough) d[v] = walk.filled;
        }
      }
      setThin(d);
      // What the user really pays or gets per PRL in dollars, wallet fee included: the ETH side is priced at Uniswap's own ETH rate.
      const usdPerEth = eu.status === "fulfilled" ? eu.value : null;
      setEthUsd(usdPerEth);
      if (uq.status === "fulfilled" && usdPerEth) {
        const wei = side === "buy" ? (uq.value as core.EthBuy).eth : (uq.value as core.Route).amountOut;
        const perPrl = ((Number(wei) / 1e18) * usdPerEth) / prlToNumber(grains);
        p.uniswap = side === "buy" ? perPrl / uniKeep : perPrl * uniKeep;
      }
      setUniBuy(side === "buy" && uq.status === "fulfilled" ? (uq.value as core.EthBuy) : null);
      setUniSell(side === "sell" && uq.status === "fulfilled" ? (uq.value as core.Route) : null);
      setPrices(p);
      setLoading(false);
    }, 450);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [amount, side]);

  const ranked = (Object.keys(prices) as Venue[]).sort((a, b) => (side === "buy" ? prices[a]! - prices[b]! : prices[b]! - prices[a]!));
  const best = ranked.find((v) => thin[v] === undefined); // a venue that cannot fill the amount is never "best"
  const chosen = venue && prices[venue] ? venue : (best ?? null);
  // Picking Uniswap is using Ethereum: from then on its balances are read, like Swap and Bridge do.
  useEffect(() => {
    if (chosen === "uniswap" && !settings.ethereum) void saveSettings({ ethereum: true });
  }, [chosen, settings.ethereum]);

  // Orders are not placed from inside Keshi (1.0.2): the exchanges are reached on their own sites. See CHANGELOG, audit H-01/H-02.
  const swapUni = async () => {
    if (side === "buy" ? !uniBuy : !uniSell) return;
    setBusy(true);
    setError("");
    try {
      if (side === "buy") await store.buyWithEth(secrets, uniBuy!, setStep);
      else await store.swap(secrets, uniSell!, setStep, true);
      setDone(side === "sell" ? `Sold ${formatPrl(uniSell!.amountIn)} wPRL for about ${uniGets}. The ETH is on your Ethereum address.` : `Bought ${uniGets}. Use Bridge to bring it to Pearl as PRL.`);
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
      setStep("");
    }
  };

  // Practice coins cannot be bought or sold: the exchanges and Uniswap only deal in real PRL, and a purchase here would spend real money.
  if (net.id !== "mainnet")
    return (
      <div className="screen">
        <Header title={side === "buy" ? "Buy PRL" : "Sell PRL"} onBack={onClose} />
        <p className="muted pad">Buying and selling only work on Pearl mainnet. The testnet uses practice coins, which no exchange trades. Switch to the mainnet in Settings.</p>
      </div>
    );

  const verb = side === "buy" ? "Buy" : "Sell";
  const total = (v: Venue) => (prices[v] ? prices[v]! * qty : 0);
  // Selling: what the user can actually sell. PRL in Keshi goes anywhere; wPRL on Ethereum only to Uniswap.
  const prlHave = snap ? core.spendableTotal(snap) : null;
  const wprlHave = hold?.wprl ?? 0n;
  const sellable = prlHave === null ? null : prlHave + wprlHave;
  const tooMuch = side === "sell" && !!grains && sellable !== null && hold !== null && grains > sellable;
  const fmtMax = (v: bigint) => formatPrl(v).replace(/,/g, "");
  const usdt = (n: number) => n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const uni = side === "buy" ? uniBuy : uniSell;
  // Buying takes up to 1% more ETH than quoted if the price moves, plus the Ethereum fee: ask for that much, rounded up.
  const feeReserve = ethNeed ?? core.MIN_SWAP_ETH;
  const ethBuyNeed = uniBuy ? core.ethBuyMax(uniBuy) + feeReserve : 0n;
  const roundEth = (wei: bigint) => `${core.formatEth(wei + 99_999_999_999_999n, 4)} ETH`;
  const ethText = roundEth(feeReserve);
  const inUsd = (wei: bigint) => (ethUsd ? ` (${usd((Number(wei) / 1e18) * ethUsd)})` : "");
  const sellGetsWei = uniSell ? (uniSell.amountOut * BigInt(Math.round(uniKeep * 10_000))) / 10_000n : 0n;
  const uniValueUsd = uni && ethUsd ? (Number(side === "buy" ? uniBuy!.eth : uniSell!.amountOut) / 1e18) * ethUsd : null;
  // The dollar figure is computed the same way as the venue list, so both show the same cents.
  const sellGetsUsd = uniSell && ethUsd ? ` (${usd((Number(uniSell.amountOut) / 1e18) * ethUsd * uniKeep)})` : "";
  const uniGets = uni ? (side === "sell" ? `${core.formatEth(sellGetsWei, 4)} ETH${sellGetsUsd}` : formatPrl(uniBuy!.wprl - (uniBuy!.wprl * (uniFee?.bips ?? 0n)) / 10_000n) + " wPRL") : "";

  return (
    <div className="screen">
      <Header title={`${verb} PRL`} onBack={onClose} />
      {side === "buy" && (
        <div className="seg paytabs" role="tablist">
          <button role="tab" aria-selected={pay === "usdt"} className={pay === "usdt" ? "on" : ""} onClick={() => setPay("usdt")}>
            Buy with USDT
            <small>Arbitrum · BNB Chain · Polygon</small>
          </button>
          <button role="tab" aria-selected={pay === "exchange"} className={pay === "exchange" ? "on" : ""} onClick={() => setPay("exchange")}>
            Exchange
            <small>SafeTrade · BigONE · Uniswap</small>
          </button>
        </div>
      )}
      {side === "buy" && pay === "usdt" && <UsdtBuy secrets={secrets} net={net} snap={snap} price={price} reload={reload} settings={settings} saveSettings={saveSettings} open={open} embedded />}
      {!(side === "buy" && pay === "usdt") && (<>
      <label className="field">
        <span>
          How much PRL <em>{side === "sell" && snap ? `${formatPrl(core.spendableTotal(snap))} in wallet` : ""}</em>
        </span>
        <span className={side === "sell" ? "with-max" : undefined}>
          <input inputMode="decimal" placeholder="0.00" value={amount} autoFocus onChange={(e) => setAmount(e.target.value)} />
          {side === "sell" && sellable !== null && sellable > 0n && (
            <button type="button" className="btn small" onClick={() => setAmount(fmtMax(sellable))}>
              Max
            </button>
          )}
        </span>
      </label>
      {side === "sell" && wprlHave > 0n && <p className="muted small">You also have {formatPrl(wprlHave)} wPRL on Ethereum. It can be sold on Uniswap without the bridge.</p>}
      {tooMuch && (
        <p className="error">
          You have {formatPrl(prlHave!)} PRL{wprlHave > 0n ? ` and ${formatPrl(wprlHave)} wPRL` : ""}. Enter {formatPrl(sellable!)} or less.
        </p>
      )}

      {qty > 0 && !tooMuch && (
        <>
          <h3>{side === "buy" ? "Where to buy" : "Where to sell"}</h3>
          {loading && ranked.length === 0 && <p className="muted small">Getting prices…</p>}
          {!loading && ranked.length === 0 && <p className="hint">No price available right now. Check your connection and try again.</p>}
          <div className="venues" role="radiogroup" aria-label="Where to trade">
            {ranked.map((v) => (
              <button key={v} role="radio" aria-checked={chosen === v} className={chosen === v ? "on" : ""} onClick={() => setVenue(v)}>
                <span className="main">
                  <span>
                    {VENUE[v].name}
                    {v === best && ranked.length > 1 && <b className="tag best">Best price</b>}
                    {v === "uniswap" && <b className="tag soft">No account</b>}
                  </span>
                  <small>{VENUE[v].how}</small>
                </span>
                <span className="main end">
                  <span className="amt">{usdt(total(v))} USDT</span>
                  <small>
                    {prices[v]!.toFixed(4)} per PRL{thin[v] !== undefined ? ` · only ${thin[v]!.toLocaleString("en-US", { maximumFractionDigits: 2 })} PRL in the book` : ""}
                  </small>
                </span>
              </button>
            ))}
          </div>
          <p className="muted small">
            Average prices for your amount, walking each venue's order book. "Best price" compares those prices only: an exchange's own trading and withdrawal fees, and on
            Uniswap the Ethereum fee, come on top and are shown at the next step.
          </p>
        </>
      )}

      {qty > 0 && chosen && chosen !== "uniswap" && (
        <div className="card">
          {side === "buy" ? (
            <>
              <ol className="howto">
                <li>Buy your PRL on {VENUE[chosen].name}'s website.</li>
                <li>Withdraw it there to your Keshi address.</li>
              </ol>
              <a className="btn primary" href={VENUE[chosen].site} target="_blank" rel="noreferrer">
                Open {VENUE[chosen].name}
              </a>
              <button className="btn" disabled={!snap} onClick={() => snap && copy(snap.receive.address, "prl")}>
                {copied === "prl" ? "Copied" : "Copy my PRL address"}
              </button>
            </>
          ) : (
            <>
              <ol className="howto">
                <li>On {VENUE[chosen].name}'s website, copy your PRL deposit address.</li>
                <li>Send your PRL to it from Keshi, then sell there.</li>
              </ol>
              <a className="btn primary" href={VENUE[chosen].site} target="_blank" rel="noreferrer">
                Open {VENUE[chosen].name}
              </a>
              {prlHave !== null && grains! > prlHave ? (
                <p className="hint">
                  Only PRL in your Keshi wallet can be sent to {VENUE[chosen].name}: you have {formatPrl(prlHave)} PRL. Sell {formatPrl(prlHave)} or less there{wprlHave > 0n ? ", or sell your wPRL on Uniswap" : ""}.
                </p>
              ) : (
                <button
                  className="btn"
                  disabled={!snap}
                  onClick={() => open(grains === prlHave ? { kind: "send", max: true, title: `Send PRL to ${VENUE[chosen].name}` } : { kind: "send", amount: qty ? String(qty) : undefined, title: `Send PRL to ${VENUE[chosen].name}` })}
                >
                  Send {grains === prlHave ? "all my" : qty} PRL
                </button>
              )}
              {grains === prlHave && <p className="muted small">The Pearl network fee comes out of this amount.</p>}
            </>
          )}
          <p className="muted small">The exchange's own trading and withdrawal fees apply there. Keshi takes no fee on exchange purchases or sales.</p>
        </div>
      )}

      {qty > 0 && chosen === "uniswap" && uni && (
        <div className="card">
          <p className="muted small">
            On your Ethereum address: {hold ? `${formatPrl(hold.wprl)} wPRL, ${core.formatEth(hold.eth)} ETH` : "reading balances…"}
          </p>
          {/* The same card whatever the amount: what is missing, if anything, then the action with its price. */}
          {side === "sell" && hold && uniSell && hold.wprl < uniSell.amountIn && (
            <>
              <p className="hint">
                You hold {formatPrl(hold.wprl)} wPRL. Turn <b>{formatPrl(uniSell.amountIn - hold.wprl)} PRL</b> into wPRL with the bridge first (PRL on Ethereum, one for one, minus the bridge's fee; no ETH needed), then come back and sell.
              </p>
              <button className="btn primary" onClick={() => open({ kind: "bridge", amount: fmtMax(uniSell.amountIn - hold.wprl) })}>
                Bridge {formatPrl(uniSell.amountIn - hold.wprl)} PRL to wPRL
              </button>
              {hold.wprl > 0n && (
                <button className="btn" onClick={() => setAmount(fmtMax(hold.wprl))}>
                  Sell the {formatPrl(hold.wprl)} wPRL I already have
                </button>
              )}
            </>
          )}
          {side === "buy" && hold && uniBuy && hold.eth < ethBuyNeed && (
            <>
              <p className="hint">
                This purchase needs about <b>{roundEth(ethBuyNeed)}</b> on your Ethereum address{inUsd(ethBuyNeed)}: the ETH it costs, room for the price to move, and the Ethereum fee. You have {core.formatEth(hold.eth, 4)} ETH: send about <b>{roundEth(ethBuyNeed - hold.eth)} more</b>, then tap Buy.
              </p>
              <GetEth address={hold.address} label="Show my Ethereum address" lead="Ethereum fees and Uniswap purchases are paid in ETH, sent to your Ethereum address in Keshi." />
            </>
          )}
          {side === "sell" && hold && uniSell && hold.wprl >= uniSell.amountIn && hold.eth < feeReserve && (
            <p className="hint">Keep about {ethText} on your Ethereum address to pay Ethereum fees. You have {core.formatEth(hold.eth)} ETH.</p>
          )}
          <SmallSwap valueUsd={uniValueUsd} costUsd={uniCost} />
          <button className={`btn ${side}`} disabled={busy || !hold || hold.eth === 0n || (side === "buy" ? hold.eth < ethBuyNeed : hold.wprl < uniSell!.amountIn)} onClick={swapUni}>
            {busy ? "Working…" : side === "sell" ? `Sell ${formatPrl(uniSell!.amountIn)} wPRL for about ${uniGets}` : `Buy ${uniGets} for about ${core.formatEth(uniBuy!.eth, 4)} ETH${inUsd(uniBuy!.eth)}`}
          </button>
          <p className="muted small">
            {uniFee ? `Price includes a ${uniFee.label} Keshi fee. ` : ""}
            The swap is cancelled if the price moves more than 1% against you, or if it is not confirmed within 20 minutes. {uniCost ? `Ethereum fee: about ${usd(uniCost)}, paid in ETH. ` : ""}{side === "buy" ? "Any ETH not needed comes straight back to you. Afterwards, Bridge turns the wPRL into PRL." : "The ETH arrives on your Ethereum address."}
          </p>
        </div>
      )}
      {step && <p className="muted small">{step}</p>}
      {error && <p className="error">{error}</p>}
      {done && <p className="ok">{done}</p>}
      {done && side === "buy" && chosen === "uniswap" && (
        <button className="btn" onClick={() => open({ kind: "bridge" })}>
          Bridge wPRL to PRL
        </button>
      )}
      </>)}
    </div>
  );
}

/* --------------------------------------------------------------- Tokens */

const tokenPrice = (grains: number) => {
  const prl = grains / 1e8;
  return prl >= 1 ? prl.toFixed(2) : prl.toFixed(8).replace(/0+$/, "");
};

const bigCompact = (n: bigint) => (n < 1_000_000_000_000_000n ? compact(Number(n)) : n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ","));

function Tokens(props: Ctx & { prlUsd: number | null; onClose: () => void }) {
  const { prlUsd, secrets, net, snap, reload, onClose } = props;
  // Sending a token or an inscription opens over the list; the list comes back when it closes.
  const [sending, setSending] = useState<{ kind: "token"; token: core.Token } | { kind: "ins"; ins: core.Inscription } | null>(null);
  const [transfer, setTransfer] = useState<store.PendingTransfer | null>(null);
  const [transferState, setTransferState] = useState<"unpublished" | "ready" | "refused" | "unknown" | "delivered" | "lost">("unknown");
  const [transferBusy, setTransferBusy] = useState(false);
  const [transferMsg, setTransferMsg] = useState("");
  /** Run one action on the pending transfer, then read where it stands. */
  const transferAct = async (act: () => Promise<void>) => {
    setTransferBusy(true);
    setTransferMsg("");
    try {
      await act();
    } catch (e) {
      setTransferMsg(errText(e));
    } finally {
      const t = await store.pendingTransfer(net);
      const st = t ? await store.transferState(net).catch(() => "unknown" as const) : "unknown";
      if (st === "delivered") setDoneNote("Sent. The tokens are on their way to the recipient.");
      setTransfer(st === "delivered" ? null : (t ?? null));
      setTransferState(st);
      setTransferBusy(false);
      reload();
    }
  };
  const [copied, copy] = useCopy();
  const [list, setList] = useState<core.Token[] | null>(null);
  const [mine, setMine] = useState<Record<string, bigint>>({});
  const [pending, setPending] = useState<store.PendingReveal | null>(null);
  const [error, setError] = useState("");
  const [sel, setSel] = useState<core.Token | null>(null);
  const [count, setCount] = useState(1);
  const [quote, setQuote] = useState<store.MintQuote | null>(null);
  const [state, setState] = useState<"idle" | "quoting" | "minting" | { txid: string; label: string }>("idle");
  const [mintError, setMintError] = useState("");
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [held2, setHeld2] = useState<core.Inscription[] | null>(null);
  const [held2Failed, setHeld2Failed] = useState(false);
  const [doneNote, setDoneNote] = useState("");
  const [pics, setPics] = useState<Record<string, string>>({});

  const loadMine = useCallback(() => {
    store.tokenBalances(secrets, net, snap).then(setMine).catch(() => {});
    store.pendingReveal(net).then((p) => setPending(p ?? null));
    store
      .inscriptions(secrets, net, snap)
      .then((l) => { setHeld2(l); setHeld2Failed(false); })
      .catch(() => setHeld2Failed(true)); // what was on screen stays; the user is told it could not be refreshed
    store.pendingTransfer(net).then((t) => {
      setTransfer(t ?? null);
      if (t)
        store
          .transferState(net)
          .then((st) => {
            setTransferState(st);
            if (st === "delivered") setTransfer(null);
          })
          .catch(() => setTransferState("unknown"));
    });
  }, [secrets, net.id, snap?.updated]);
  // Pictures come one by one, small files only; a missing one shows a plain tile.
  useEffect(() => {
    if (!held2) return;
    const idx = new core.TokenIndex();
    let live = true;
    for (const i of held2.filter((x) => x.image).slice(0, 12)) {
      if (pics[i.id]) continue;
      idx.inscriptionImage(i).then((url) => {
        if (live && url) setPics((m) => ({ ...m, [i.id]: url }));
      }).catch(() => {});
    }
    return () => {
      live = false;
    };
  }, [held2]);

  useEffect(() => {
    new core.TokenIndex().tokens().then(setList).catch(() => setError("The token index is not answering right now."));
  }, []);
  useEffect(loadMine, [loadMine]);

  const publish = async () => {
    setMintError("");
    try {
      await store.publishPending(net);
      setPending(null);
      reload();
    } catch (e) {
      setMintError(errText(e));
    }
  };

  const startMint = async (t: core.Token) => {
    if (!snap) return;
    setMintError("");
    setState("quoting");
    try {
      setQuote(await store.quoteMint(secrets, net, snap, t, count));
      setState("idle");
    } catch (e) {
      setMintError(errText(e));
      setState("idle");
    }
  };

  const confirmMint = async () => {
    if (!snap || !quote) return;
    setState("minting");
    setMintError("");
    try {
      const txid = await store.mint(secrets, net, snap, quote);
      setState({ txid, label: quote.label });
      setQuote(null);
      reload();
    } catch (e) {
      setMintError(errText(e));
      setState("idle");
      setQuote(null);
      loadMine();
    }
  };

  if (typeof state === "object")
    return (
      <>
        <div className="done">
          <div className="pearl" aria-hidden="true" />
          <h2>Mint sent</h2>
          <p className="muted">
            {state.label}. The tokens appear in your balance once the transaction is confirmed and indexed, usually within a few minutes.
          </p>
        </div>
        <div className="stack">
          <a className="btn" href={net.explorerTx.replace("{txid}", state.txid)} target="_blank" rel="noreferrer">
            View on the Pearl explorer
          </a>
          <button
            className="btn primary"
            onClick={() => {
              setState("idle");
              setSel(null);
              loadMine();
            }}
          >
            Done
          </button>
        </div>
      </>
    );

  if (sending) {
    const back = () => {
      setSending(null);
      setSel(null);
      loadMine();
    };
    if (sending.kind === "token") return <TokenSend {...props} token={sending.token} have={mine[sending.token.ticker] ?? 0n} onClose={back} />;
    return <InscriptionSend {...props} ins={sending.ins} pic={pics[sending.ins.id]} held={held2 ?? []} onClose={back} />;
  }

  if (sel && quote) {
    const p = quote.plan;
    const network = p.fee + quote.revealFee;
    return (
      <>
        <Header title="Review mint" onBack={() => state === "idle" && setQuote(null)} />
        <p className="hero-amt">
          {compact(sel.perMint * quote.count)} <small>{sel.name}</small>
        </p>
        <dl className="rows">
          <Row k="Mints" v={`${quote.count} × ${compact(sel.perMint)} ${sel.name}`} />
          <Row k="Network fees" v={`${formatPrl(network)} PRL`} />
          {p.serviceFee > 0n && <Row k="Keshi fee" v={`${formatPrl(p.serviceFee)} PRL`} />}
          <Row k="Kept with your tokens" v={`${formatPrl(core.INSCRIPTION_VALUE)} PRL`} />
          <Row k="Total leaving your balance" v={`${formatPrl(network + p.serviceFee)} PRL`} />
        </dl>
        <p className="muted small">
          A mint only counts if supply is left when it confirms. If the token sells out first, the fees are spent and no tokens are credited. This cannot be undone.
        </p>
        {mintError && <p className="error">{mintError}</p>}
        <div className="grow" />
        <button className="btn primary" disabled={state === "minting"} onClick={confirmMint}>
          {state === "minting" ? "Minting…" : `Mint ${sel.name}`}
        </button>
      </>
    );
  }

  if (sel) {
    const cap = core.tokenCapPrl(sel);
    const have = mine[sel.ticker] ?? 0n;
    const canMint = sel.remaining > 0 && sel.perMint > 0;
    const inWallet = canMint && sel.mintFeePrl === 0 && net.id === "mainnet";
    const maxCount = Math.max(1, Math.min(core.MAX_BATCH, Math.ceil(sel.remaining / sel.perMint)));
    return (
      <>
        <Header title={sel.name} onBack={() => setSel(null)} />
        <p className="hero-amt">
          {sel.floorGrains ? tokenPrice(sel.floorGrains) : "—"} <small>PRL per token</small>
        </p>
        <dl className="rows">
          {have > 0n && <Row k="You hold" v={`${bigCompact(have)} ${sel.name}`} />}
          {sel.floorGrains && prlUsd ? <Row k="Price in dollars" v={usd((sel.floorGrains / 1e8) * prlUsd)} /> : null}
          <Row k="Market cap" v={cap ? `${compact(cap)} PRL${prlUsd ? ` (${usdCompact(cap * prlUsd)})` : ""}` : "Nothing for sale"} />
          <Row k="For sale" v={`${sel.listings} listing${sel.listings === 1 ? "" : "s"}`} />
          <Row k="Holders" v={sel.holders.toLocaleString("en-US")} />
          <Row k="Minted" v={`${compact(sel.minted)} of ${compact(sel.maxSupply)} (${sel.mintProgress}%)`} />
        </dl>
        {have > 0n && net.id === "mainnet" && (
          <button className="btn primary" disabled={!snap || !!transfer} onClick={() => setSending({ kind: "token", token: sel })}>
            Send {sel.name}
          </button>
        )}
        {have > 0n && transfer && <p className="muted small">Finish the token transfer that is on its way (Tokens list) before starting another.</p>}
        <h3>Mint</h3>
        {!canMint && <p className="muted small">Fully minted. {sel.name} can only be bought from a holder now.</p>}
        {canMint && (
          <dl className="rows">
            <Row k="You get per mint" v={`${compact(sel.perMint)} ${sel.name}`} />
            <Row k="Token fee" v={sel.mintFeePrl > 0 ? `${sel.mintFeePrl} PRL per mint` : "None"} />
            <Row k="Left to mint" v={`${compact(sel.remaining)} ${sel.name}`} />
          </dl>
        )}
        {inWallet && (
          <>
            <div className="field">
              <span>How many mints</span>
              <div className="seg">
                {[1, 5, 10, 20].filter((n) => n <= maxCount || n === 1).map((n) => (
                  <button key={n} className={count === n ? "on" : ""} onClick={() => setCount(n)}>
                    {n}
                  </button>
                ))}
              </div>
            </div>
            {mintError && <p className="error">{mintError}</p>}
            <button className="btn primary" disabled={!snap || state === "quoting" || !!pending} onClick={() => startMint(sel)}>
              {state === "quoting" ? "Calculating…" : `Mint ${compact(sel.perMint * Math.min(count, maxCount))} ${sel.name}`}
            </button>
            {pending && <p className="muted small">Finish the mint that is waiting (Tokens list) before starting another.</p>}
          </>
        )}
        {canMint && !inWallet && (
          <p className="muted small">
            {net.id !== "mainnet" ? "Switch to Pearl mainnet to mint." : "This token charges its own mint fee. Mint it on Pearlscriptions."}
          </p>
        )}
        <p className="muted small">
          A PRL-20 token has no contract address: it is identified by its ticker and by the inscription that created it. The price shown is the cheapest offer on Pearlscriptions; thinly traded tokens can be impossible to sell at that price.
        </p>
        {sel.deployId && (
          <button className="btn" onClick={() => copy(sel.deployId)}>
            {copied ? "Copied" : "Copy token ID"}
          </button>
        )}
        <a className="btn" href={core.TOKEN_MARKET_URL} target="_blank" rel="noreferrer">
          Buy or sell on Pearlscriptions
        </a>
      </>
    );
  }

  const held = list?.filter((t) => (mine[t.ticker] ?? 0n) > 0n) ?? [];
  return (
    <>
      <Header title="Tokens and inscriptions" onBack={onClose} />
      {(
        <>
          {transfer && (
            <div className="card transfer-card">
              <p>
                <b>
                  Sending {BigInt(transfer.amount).toLocaleString("en-US")} {transfer.name}
                </b>{" "}
                to {short(transfer.to)}.
              </p>
              <p className="muted small">
                {transferState === "unpublished"
                  ? "The transfer note is not on the network yet. Publish it to continue."
                  : transferState === "ready"
                    ? "The transfer note is accepted. One last step sends the tokens to the recipient."
                    : transferState === "refused"
                      ? "The token index refused the transfer note, so no token moved. You can discard this transfer."
                      : transferState === "lost"
                        ? "The Pearl network has no trace of the transfer note: it was dropped before it confirmed. Publish it again to continue."
                        : "Waiting for the token index to accept the transfer note, usually one block (a few minutes)."}
              </p>
              {snap && !snap.addresses.some((a) => a.address === transfer.holder) && <p className="hint">This transfer belongs to another of your wallets. Switch to it to finish.</p>}
              {transferMsg && <p className="hint">{transferMsg}</p>}
              <div className="row-actions">
                {transferState === "unpublished" && (
                  <button className="btn primary" disabled={transferBusy} onClick={() => transferAct(async () => { await store.publishTransfer(net); })}>
                    {transferBusy ? "Working…" : "Publish"}
                  </button>
                )}
                {transferState === "ready" && (
                  <>
                    <button className="btn primary" disabled={transferBusy} onClick={() => transferAct(async () => { const id = await store.deliverTransfer(secrets, net); setDoneNote(`Sent. Payment ${short(id, 6)} carries the tokens to the recipient.`); })}>
                      {transferBusy ? "Working…" : "Finish sending"}
                    </button>
                    <button className="btn" disabled={transferBusy} onClick={() => transferAct(async () => { await store.deliverTransfer(secrets, net, true); setDoneNote("Cancelled. The tokens come back to your address once the payment confirms."); })}>
                      Keep the tokens instead
                    </button>
                  </>
                )}
                {transferState === "lost" && (
                  <button className="btn primary" disabled={transferBusy} onClick={() => transferAct(async () => { await store.publishTransfer(net, true, true); })}>
                    {transferBusy ? "Working…" : "Publish again"}
                  </button>
                )}
                {transferState === "unknown" && (
                  <button className="btn" disabled={transferBusy} onClick={() => transferAct(async () => {})}>
                    {transferBusy ? "Checking…" : "Check again"}
                  </button>
                )}
                {(transferState === "refused" || transferState === "unpublished") && (
                  <button className="link" disabled={transferBusy} onClick={() => transferAct(async () => { await store.discardTransfer(net); })}>
                    {transferState === "refused" ? "Discard this transfer" : "Publishing keeps failing: give up (no tokens have moved)"}
                  </button>
                )}
              </div>
            </div>
          )}
          {doneNote && <p className="ok">{doneNote}</p>}
          {pending && (
            <div className="card">
              <p>A mint is paid for but not published yet: {pending.label}.</p>
              {mintError && <p className="error">{mintError}</p>}
              <button className="btn primary" onClick={publish}>
                Publish
              </button>
              {mintError && (
                <button
                  className="link"
                  onClick={async () => {
                    if (!confirmDiscard) return setConfirmDiscard(true);
                    await store.discardPending(net);
                    setPending(null);
                    setMintError("");
                    setConfirmDiscard(false);
                  }}
                >
                  {confirmDiscard ? "Yes, give up on this mint (fees already paid are not refunded)" : "It keeps failing: give up on this mint"}
                </button>
              )}
            </div>
          )}
          {held.length > 0 && (
            <>
              <h3>Your tokens</h3>
              <ul className="list">
                {held.map((t) => (
                  <li key={t.ticker}>
                    <button onClick={() => setSel(t)}>
                      <Coin name={t.name} />
                      <span className="main">
                        <span>{t.name}</span>
                      </span>
                      <span className="main end">
                        <span className="amt">{bigCompact(mine[t.ticker]!)}</span>
                        <small>{t.floorGrains ? `${compact((t.floorGrains / 1e8) * Number(mine[t.ticker]!))} PRL at floor` : ""}</small>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
          {held2Failed && <p className="hint">Your inscriptions could not be read just now{held2 ? ": the list below is the last one Keshi read" : ""}. Try again in a moment.</p>}
          {held2 && held2.length > 0 && (
            <>
              <h3>Inscriptions you hold</h3>
              <ul className="list inscriptions">
                {held2.slice(0, 50).map((i) => (
                  <li key={i.id}>
                    <button className="row" onClick={() => setSending({ kind: "ins", ins: i })} aria-label={`Send ${i.number >= 0 ? `inscription #${i.number}` : "this inscription"}`}>
                      {pics[i.id] ? <img className="thumb" src={pics[i.id]} alt="" /> : <span className="thumb glyph">{i.image ? "🖼" : i.contentType === "application/json" ? "{ }" : "Aa"}</span>}
                      <span className="main">
                        <span>{i.number >= 0 ? `Inscription #${i.number.toLocaleString("en-US")}` : "Inscription"}</span>
                        <small>{i.preview ? i.preview : `${i.contentType || "file"}${i.bytes ? `, ${i.bytes < 1024 ? `${i.bytes} B` : `${(i.bytes / 1024).toFixed(1)} KB`}` : ""}`}</small>
                      </span>
                      <span className="main end">
                        <small className="tag">Protected</small>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
              <p className="muted small">The coins that hold these are kept out of ordinary payments. Tap one to send it. Pictures are shown for small files only.</p>
            </>
          )}
          {(held.length > 0 || (held2 && held2.length > 0)) && <h3>All tokens</h3>}
          {error && <p className="error">{error}</p>}
          {!list && !error && <Skeleton />}
          {list && list.length === 0 && <p className="muted pad">No token has been issued on Pearl yet.</p>}
          {list && (
            <ul className="list">
              {list.map((t) => (
                <li key={t.ticker}>
                  <button
                    onClick={() => {
                      setCount(1);
                      setMintError("");
                      setSel(t);
                    }}
                  >
                    <Coin name={t.name} />
                    <span className="main">
                      <span>{t.name}</span>
                      <small>
                        {t.holders.toLocaleString("en-US")} holder{t.holders === 1 ? "" : "s"}, {t.mintProgress >= 100 ? "fully minted" : `${t.mintProgress}% minted`}
                      </small>
                    </span>
                    <span className="main end">
                      <span className="amt">{t.floorGrains ? `${tokenPrice(t.floorGrains)} PRL` : "—"}</span>
                      <small>{t.floorGrains && prlUsd ? usd((t.floorGrains / 1e8) * prlUsd) : t.floorGrains ? "" : t.remaining > 0 ? "mint open" : "none for sale"}</small>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </>
  );
}

const PHASE: Record<core.CrossingStatus["phase"], string> = {
  pending: "On its way",
  done: "wPRL issued",
  refunded: "Refunded",
  failed: "Failed",
  review: "Held for review by the bridge",
};

function BridgeSheet({ secrets, net, snap, open, reload, onClose, preset, settings, saveSettings }: Ctx & { open: (s: Sheet) => void; onClose: () => void; preset?: string }) {
  useEthereumSide(settings, saveSettings);
  const own = useMemo(() => core.ethAccountOf(secrets).address, [secrets]);
  const mine = useMemo(() => core.accountOf(secrets, net).derive(false, 0).address, [secrets, net.id]);
  /** Whether the Ethereum destination is a smart contract (null: not checked yet). A contract needs an explicit go-ahead. */
  const [destContract, setDestContract] = useState<boolean | null>(null);
  const [contractAck, setContractAck] = useState(false);
  const [dir, setDir] = useState<"out" | "back">("out");
  const [eth, setEth] = useState(own);
  const [amount, setAmount] = useState(preset ?? "");
  const [quote, setQuote] = useState<core.BridgeQuote | null>(null);
  const [backQuote, setBackQuote] = useState<{ amount: bigint; fee: bigint; net: bigint } | null>(null);
  const [hold, setHold] = useState<store.EthHoldings | null>(null);
  const [ethNeed, setEthNeed] = useState<bigint | null>(null);
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState("");
  const [error, setError] = useState("");
  const [done, setDone] = useState("");
  const [list, setList] = useState<store.Crossing[]>([]);
  const [status, setStatus] = useState<Record<string, core.CrossingStatus>>({});
  const [copied, copy] = useCopy();

  const loadList = useCallback(() => {
    store.crossings(own).then((l) => {
      setList(l);
      const b = new core.Bridge();
      l.slice(0, 8).forEach((c) => (c.back ? b.backStatus(c.txid) : b.status(c.txid)).then((s) => setStatus((m) => ({ ...m, [c.txid]: s }))).catch(() => {}));
    });
  }, [own]);
  const loadHold = useCallback(() => {
    store.ethHoldings(secrets).then(setHold).catch(() => {});
  }, [secrets]);
  useEffect(() => {
    loadList();
    loadHold();
    core.bridgeBackEthNeeded(new core.EthRpc()).then(setEthNeed);
  }, []);
  const bridgeService = core.serviceFor(net, "bridge");
  // Sending wPRL back takes two Ethereum transactions, paid in ETH from the Ethereum address in Keshi.
  const needEth = ethNeed ?? core.MIN_ETH_FOR_FEES;
  const shortOfEth = !!hold && hold.eth < needEth;
  const ethText = `${core.formatEth(needEth + 99_999_999_999_999n, 4)} ETH`;

  const reset = () => {
    setQuote(null);
    setBackQuote(null);
    setError("");
    setDone("");
    setDestContract(null);
    setContractAck(false);
  };

  // The limits live in the bridge's Ethereum contract. Without them, a too-small deposit could sit unprocessed.
  const bridgeBounds = () =>
    new core.EthRpc().bridgeBounds(core.BRIDGE_CONTROLLER).catch(() => {
      throw new Error("Could not read the bridge's limits from Ethereum. Nothing was sent; try again in a moment.");
    });

  const check = async () => {
    reset();
    const value = parsePrl(amount);
    if (value === null || value <= 0n) return setError("Enter an amount, for example 100");
    setBusy(true);
    try {
      if (dir === "out") {
        const dest = eth.trim();
        if (!core.isEthAddress(dest)) throw new Error("Enter the Ethereum address that should receive the wPRL (it starts with 0x)");
        // The same recipient checks as an Ethereum send: the zero address, a known contract, a checksum typo.
        const problem = core.ethRecipientProblem(dest, "", await store.ethTokens().catch(() => []));
        if (problem) throw new Error(problem);
        // A smart contract may have no way to move wPRL out: say so, and ask before going on.
        const contract = await new core.EthRpc().isContract(dest).catch(() => null);
        setDestContract(contract);
        if (contract === null) throw new Error("Keshi could not check this Ethereum address with the network just now. Try again in a moment.");
        // Check against what the wallet holds before asking the bridge anything.
        const have = snap ? core.spendableTotal(snap) : null;
        if (have !== null) {
          const keshiFee = core.commission(value, bridgeService);
          if (value > have) throw new Error(`You have ${formatPrl(have)} PRL available. Enter ${formatPrl(have)} or less.`);
          if (value + keshiFee >= have) throw new Error(`Keep a little PRL for the fees: the Keshi fee (${formatPrl(keshiFee)} PRL) and the Pearl network fee are paid on top. Try a slightly smaller amount.`);
        }
        const q = await new core.Bridge().quote(value);
        if (q.paused) throw new Error("The bridge is paused right now. Try again later.");
        if (!q.withinDailyCap) throw new Error("This amount is above what the bridge accepts today. Try a smaller amount.");
        if (q.amount !== value || q.fee < 0n || q.net !== q.amount - q.fee || q.net <= 0n) throw new Error("The bridge answered with figures that do not add up. Nothing was sent.");
        core.checkBridgeBounds(q.amount, q.net, await bridgeBounds(), formatPrl);
        setQuote(q);
      } else {
        if (hold && value > hold.wprl) throw new Error(`You have ${formatPrl(hold.wprl)} wPRL on your Ethereum address. Enter ${formatPrl(hold.wprl)} or less.`);
        const q = await new core.Bridge().quoteBack(value, mine);
        if (q.paused) throw new Error("The bridge is paused right now. Try again later.");
        if (!q.withinDailyCap) throw new Error("This amount is above what the bridge accepts today. Try a smaller amount.");
        if (q.amount !== value || q.fee < 0n || q.net !== q.amount - q.fee || q.net <= 0n) throw new Error("The bridge answered with figures that do not add up. Nothing was sent.");
        core.checkBridgeBounds(q.amount, q.net, await bridgeBounds(), formatPrl);
        setBackQuote(q);
      }
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };

  const goOut = async () => {
    if (!quote) return;
    setBusy(true);
    setError("");
    try {
      const address = await store.bridgeDepositAddress(eth.trim(), net);
      open({ kind: "send", to: address, amount: formatPrl(quote.amount).replace(/,/g, ""), title: "Bridge to Ethereum", bridgeTo: eth.trim(), locked: true });
    } catch (e) {
      setError(errText(e));
      setBusy(false);
    }
  };

  const goBack = async () => {
    if (!backQuote) return;
    setBusy(true);
    setError("");
    try {
      await store.bridgeBack(secrets, backQuote.amount, mine, setStep);
      setDone(`${formatPrl(backQuote.amount)} wPRL sent to the bridge. ${formatPrl(backQuote.net)} PRL will arrive on your Pearl address once Ethereum confirms it.`);
      setBackQuote(null);
      setAmount("");
      loadList();
      loadHold();
      reload();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
      setStep("");
    }
  };

  if (net.id !== "mainnet")
    return (
      <div className="screen">
        <Header title="Bridge" onBack={onClose} />
        <p className="muted pad">The bridge only works on Pearl mainnet.</p>
      </div>
    );

  return (
    <div className="screen">
      <Header title="Bridge" onBack={onClose} />
      <div className="seg">
        <button
          className={dir === "out" ? "on" : ""}
          onClick={() => {
            setDir("out");
            reset();
          }}
        >
          PRL to wPRL
          <small>Pearl to Ethereum</small>
        </button>
        <button
          className={dir === "back" ? "on" : ""}
          onClick={() => {
            setDir("back");
            reset();
          }}
        >
          wPRL to PRL
          <small>Ethereum to Pearl</small>
        </button>
      </div>

      <label className="field">
        <span>
          Amount{" "}
          <em>{dir === "out" ? (snap ? `${formatPrl(core.spendableTotal(snap))} PRL available` : "") : hold ? `${formatPrl(hold.wprl)} wPRL available` : ""}</em>
        </span>
        <input
          inputMode="decimal"
          placeholder="0.00"
          value={amount}
          autoFocus
          onChange={(e) => {
            setAmount(e.target.value);
            reset();
          }}
        />
      </label>
      {dir === "out" && (
        <label className="field">
          <span>
            Receive the wPRL on <em>{eth.trim().toLowerCase() === own.toLowerCase() ? "your Ethereum address in Keshi" : "another address"}</em>
          </span>
          <input
            placeholder="0x…"
            spellCheck={false}
            value={eth}
            onChange={(e) => {
              setEth(e.target.value.trim());
              reset();
            }}
          />
        </label>
      )}
      {quote && dir === "out" && (() => {
        // One fee line: PearlBridge's fee (taken from the amount) plus Keshi's (paid on top). The split is explained below the button.
        const keshiFee = bridgeService ? core.commission(quote.amount, bridgeService) : 0n;
        const fees = quote.fee + keshiFee;
        const share = Number((fees * 100n) / (quote.amount + keshiFee));
        return (
          <>
            <dl className="rows">
              <Row k="You pay" v={`${formatPrl(quote.amount + keshiFee)} PRL`} />
              <Row k="You receive on Ethereum" v={`${formatPrl(quote.net)} wPRL`} />
              <Row k="Fees" v={fees > 0n ? `${formatPrl(fees)} PRL, no ETH needed` : "None, no ETH needed"} />
              <Row k="Arrives after" v={quote.slow ? `${quote.confirmations} confirmations, then a ${Math.round(quote.delaySeconds / 3600)}-hour safety delay` : `${quote.confirmations} confirmations on Pearl`} />
            </dl>
            {share >= 20 && (
              <p className="hint warn">
                Fees take about {share}% of this amount: PearlBridge charges at least 4 PRL per crossing. Under a few hundred PRL, a crossing is rarely worth it.
              </p>
            )}
          </>
        );
      })()}
      {backQuote && dir === "back" && (
        <dl className="rows">
          <Row k="You receive on Pearl" v={`${formatPrl(backQuote.net)} PRL`} />
          <Row k="Fees" v={backQuote.fee > 0n ? `${formatPrl(backQuote.fee)} wPRL, plus up to about ${ethText} in Ethereum fees` : `up to about ${ethText}, paid in ETH`} />
          {hold && <Row k="Your wPRL after" v={<After from={`${formatPrl(hold.wprl, 4)} wPRL`} to={`${formatPrl(hold.wprl - backQuote.amount < 0n ? 0n : hold.wprl - backQuote.amount, 4)} wPRL`} />} />}
          {snap && <Row k="Your PRL after" v={<After from={`${formatPrl(snap.balance, 4)} PRL`} to={`${formatPrl(snap.balance + backQuote.net, 4)} PRL`} about />} />}
        </dl>
      )}
      {dir === "back" && shortOfEth && (
        <GetEth
          address={own}
          shown
          lead={
            <>
              Sending wPRL back takes two Ethereum transactions, paid in ETH. Send about <b>{ethText}</b> to your Ethereum address first. You have {core.formatEth(hold!.eth)} ETH.
            </>
          }
        />
      )}
      {step && <p className="muted small">{step}</p>}
      {error && <p className="error">{error}</p>}
      {done && <p className="ok">{done}</p>}
      {dir === "out" && !quote && (
        <button className="btn primary" disabled={busy || !eth || !amount} onClick={check}>
          {busy ? "Checking…" : "Check the bridge"}
        </button>
      )}
      {dir === "out" && quote && destContract && (
        <label className="check">
          <input type="checkbox" checked={contractAck} onChange={(e) => setContractAck(e.target.checked)} />
          <span>
            {short(eth.trim(), 6)} is a smart contract, not a wallet. Many contracts have no way to move wPRL out, and an exchange deposit contract may not credit it. I checked that this
            contract can receive wPRL.
          </span>
        </label>
      )}
      {dir === "out" && quote && (
        <button className="btn primary" disabled={busy || !snap || (destContract === true && !contractAck)} onClick={goOut}>
          {busy ? "Preparing…" : "Continue to payment"}
        </button>
      )}
      {dir === "out" && quote && <p className="muted small">First crossing to this Ethereum address? Start with a small amount: the deposit address comes from PearlBridge and Keshi cannot verify it on its own.</p>}
      <p className="muted small">The Fees line adds up PearlBridge's fee (0.5%, at least 4 PRL per crossing, waived on very small amounts; paid to PearlBridge, not to Keshi) and Keshi's ({bridgeService ? bridgeService.label : "0.1%"}, never more than {bridgeService ? formatPrl(bridgeService.cap) : "3"} PRL). Keshi cannot change or refund PearlBridge's fee, and a crossing cannot be reversed.</p>
      {dir === "back" && !backQuote && (
        <button className="btn primary" disabled={busy || !amount || !hold || hold.wprl === 0n} onClick={check}>
          {busy ? "Checking…" : "Check the bridge"}
        </button>
      )}
      {dir === "back" && backQuote && (
        <button className="btn primary" disabled={busy || !hold || shortOfEth} onClick={goBack}>
          {busy ? "Working…" : `Send ${formatPrl(backQuote.amount)} wPRL back`}
        </button>
      )}

      {list.length > 0 && (
        <>
          <h3>Your crossings</h3>
          <ul className="list plain">
            {list.map((c) => {
              const s = status[c.txid];
              return (
                <li key={c.txid}>
                  <span className="main">
                    <span>{c.back ? `${formatPrl(c.amount, 4)} wPRL back to PRL` : `${formatPrl(c.amount, 4)} PRL to ${short(c.eth, 4)}`}</span>
                    <small>{s ? (s.phase === "done" ? (c.back ? "PRL released" : "wPRL issued") : PHASE[s.phase]) : "Checking…"}{s?.detail ? `: ${s.detail}` : ""}</small>
                  </span>
                  {(c.back || s?.ethTx) && (
                    <a className="link" href={`https://etherscan.io/tx/${c.back ? c.txid : s!.ethTx}`} target="_blank" rel="noreferrer">
                      Etherscan
                    </a>
                  )}
                </li>
              );
            })}
          </ul>
        </>
      )}

      {!(dir === "back" && shortOfEth) && (
        <EthAddressCard address={own}>
          <p className="muted small">{hold ? `On it: ${formatPrl(hold.wprl)} wPRL and ${core.formatEth(hold.eth)} ETH.` : "Reading balances…"}</p>
        </EthAddressCard>
      )}

      <details className="explain">
        <summary>How the bridge works</summary>
        <p>wPRL is PRL on Ethereum, one for one. It lets you trade on Uniswap and use Ethereum apps. The bridge is run by PearlBridge, not by Keshi: it holds your PRL for as long as the wPRL exists.</p>
        <h4>From Pearl to Ethereum</h4>
        <ol>
          <li>You send PRL to a deposit address that belongs to your Ethereum address. This is a normal Pearl payment: no ETH is needed.</li>
          <li>After enough confirmations on Pearl (6 up to 1,000 PRL, more for larger amounts; the review screen shows the exact number), the bridge issues the same amount of wPRL on Ethereum.</li>
          <li>Large amounts wait an extra safety delay before they are issued.</li>
        </ol>
        <h4>From Ethereum to Pearl</h4>
        <ol>
          <li>Keshi allows the bridge to take the exact amount of wPRL, then hands it over. Both steps are Ethereum transactions and cost a little ETH, paid from your Ethereum address in Keshi.</li>
          <li>The bridge destroys the wPRL and releases the PRL to your Pearl address.</li>
        </ol>
        <h4>Your Ethereum address</h4>
        <p>
          Keshi creates it from the same recovery phrase as your Pearl wallet, the standard way: any Ethereum wallet that restores this phrase shows the same address{core.accountNumber(secrets) > 0 ? `, under account ${core.accountNumber(secrets) + 1}` : ""}. Only send wPRL to an address you control: an exchange deposit address may not credit it.
        </p>
      </details>
    </div>
  );
}

/* --------------------------------------------------------------- Mining */

function Mining({ snap, secrets, net, price, open, settings }: Ctx & { open: (s: Sheet) => void }) {
  const address = useMemo(() => core.accountOf(secrets, net).derive(false, 0).address, [secrets, net.id]);
  const [copied, copy] = useCopy();
  const stats = useMemo(() => (snap ? core.miningStats(snap.activity) : null), [snap]);
  const coins = snap ? core.spendable(snap).length : 0;
  const top = stats ? stats.days.reduce((m, d) => (d.total > m ? d.total : m), 1n) : 1n;
  const hidden = settings.hideBalance;
  const combineFee = core.serviceFor(net, "combine");

  const exportCsv = () => {
    if (!stats) return;
    const url = URL.createObjectURL(new Blob([core.payoutsCsv(stats.payouts)], { type: "text/csv" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `keshi-payouts-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <>
      <header className="head">
        <h2>Mining</h2>
      </header>
      <div className="card">
        <span className="muted small">Payout address for your pool</span>
        <p className="addr left">{address}</p>
        <button className="btn" onClick={() => copy(address)}>
          {copied ? "Copied" : "Copy payout address"}
        </button>
      </div>
      <div className="stats">
        <div>
          <span className="muted small">Today</span>
          <strong>{stats ? (hidden ? "•••" : formatPrl(stats.today, 4)) : "—"}</strong>
          <span className="muted small">{stats && price && !hidden ? usd(prlToNumber(stats.today) * price) : "PRL"}</span>
        </div>
        <div>
          <span className="muted small">Last 7 days</span>
          <strong>{stats ? (hidden ? "•••" : formatPrl(stats.last, 4)) : "—"}</strong>
          <span className="muted small">{stats && price && !hidden ? usd(prlToNumber(stats.last) * price) : "PRL"}</span>
        </div>
        <div>
          <span className="muted small">Daily average</span>
          <strong>{stats ? (hidden ? "•••" : formatPrl(stats.average, 4)) : "—"}</strong>
          <span className="muted small">{stats && price && !hidden ? usd(prlToNumber(stats.average) * price) : "PRL"}</span>
        </div>
      </div>
      {stats && (
        <div className="bars" role="img" aria-label="Payouts per day over the last 7 days">
          {stats.days.map((d) => (
            <div key={d.start} title={`${formatPrl(d.total, 4)} PRL in ${d.count} payout${d.count === 1 ? "" : "s"}`}>
              <i style={{ height: `${Math.max(2, Number((d.total * 100n) / top))}%` }} className={d.total === 0n ? "zero" : ""} />
              <span>{new Date(d.start).toLocaleDateString("en-GB", { weekday: "narrow" })}</span>
            </div>
          ))}
        </div>
      )}
      {coins >= 20 && (
        <div className="card">
          <p>
            Your balance is split across {coins} separate payouts. Combining them into one makes future payments smaller and cheaper.
            {combineFee ? ` Keshi fee: ${combineFee.label}, never more than ${formatPrl(combineFee.cap)} PRL.` : ""}
          </p>
          <button className="btn" onClick={() => open({ kind: "send", to: snap!.receive.address, max: true, title: "Combine payouts", combine: true })}>
            Combine payouts
          </button>
        </div>
      )}
      <div className="row-head">
        <h3>Payouts</h3>
        {stats && stats.payouts.length > 0 && (
          <button className="link" onClick={exportCsv}>
            Export CSV
          </button>
        )}
      </div>
      <ActivityList items={stats?.payouts.slice(0, 40) ?? null} prices={{ prl: price }} hidden={hidden} open={open} empty="No payouts yet. Paste the address above into your mining pool as the payout address." />
    </>
  );
}

/* ------------------------------------------------------------- Settings */

function SettingsTab({ secrets, setSecrets, settings, saveSettings, onLock }: Ctx & { setSecrets: (s: core.Secrets) => void; saveSettings: (p: Partial<Settings>) => Promise<void>; onLock: () => void }) {
  const [view, setView] = useState<"menu" | "phrase" | "contacts" | "sites" | "twostep" | "wallets">("menu");
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [sites, setSites] = useState<Record<string, Site>>({});
  const [removing, setRemoving] = useState<"exchange" | "bigone" | null>(null);
  const [rmPw, setRmPw] = useState("");
  const [rmError, setRmError] = useState("");
  const [rmBusy, setRmBusy] = useState(false);
  const [copied, copy] = useCopy();
  useEffect(() => {
    local.get<Contact[]>("contacts").then((c) => setContacts(c ?? []));
    local.get<Record<string, Site>>("sites").then((s) => setSites(s ?? {}));
  }, [view]);

  if (removing)
    return (
      <>
        <Header title={`Disconnect ${removing === "bigone" ? "BigONE" : "SafeTrade"}`} onBack={() => setRemoving(null)} />
        <p className="muted">The API key is removed from this device. Enter your wallet password to confirm.</p>
        <label className="field">
          <span>Wallet password</span>
          <input type="password" autoFocus value={rmPw} onChange={(e) => setRmPw(e.target.value)} />
        </label>
        {rmError && <p className="error">{rmError}</p>}
        <button
          className="btn primary"
          disabled={!rmPw || rmBusy}
          onClick={async () => {
            setRmBusy(true);
            setRmError("");
            const which = removing;
            try {
              setSecrets(
                await store.saveSecrets((s) => {
                  const next = { ...s };
                  delete next[which];
                  return next;
                }, rmPw),
              );
              setRemoving(null);
              setRmPw("");
            } catch (e) {
              setRmError(errText(e));
            } finally {
              setRmBusy(false);
            }
          }}
        >
          {rmBusy ? "Working…" : "Remove the key"}
        </button>
      </>
    );
  if (view === "phrase") return <ShowPhrase index={settings.wallet ?? 0} onClose={() => setView("menu")} />;
  if (view === "wallets") return <Wallets secrets={secrets} setSecrets={setSecrets} settings={settings} saveSettings={saveSettings} onClose={() => setView("menu")} />;
  if (view === "twostep") return <TwoStep secrets={secrets} setSecrets={setSecrets} onClose={() => setView("menu")} />;
  if (view === "contacts") return <Contacts net={core.networkById(settings.network)} contacts={contacts} onClose={() => setView("menu")} />;
  if (view === "sites")
    return (
      <>
        <Header title="Connected sites" onBack={() => setView("menu")} />
        {Object.keys(sites).length === 0 && <p className="muted pad">No site is connected. Sites can only see your address after you approve them.</p>}
        <ul className="list plain">
          {Object.entries(sites).map(([origin]) => (
            <li key={origin}>
              <span className="main">
                <span>{origin.replace(/^https?:\/\//, "")}</span>
              </span>
              <button
                className="link"
                onClick={async () => {
                  const next = { ...sites };
                  delete next[origin];
                  await local.set("sites", next);
                  setSites(next);
                }}
              >
                Disconnect
              </button>
            </li>
          ))}
        </ul>
      </>
    );

  return (
    <>
      <header className="head">
        <h2>Settings</h2>
      </header>
      <h4 className="group">Your wallet</h4>
      <ul className="menu">
        <li>
          <button onClick={() => setView("wallets")}>
            Wallets <small>{core.walletsOf(secrets).length > 1 ? `${core.walletsOf(secrets).length}, using ${core.walletsOf(secrets)[settings.wallet ?? 0]?.name ?? ""}` : "Import or add a wallet"}</small>
          </button>
        </li>
        <li>
          <button onClick={() => setView("contacts")}>
            Saved addresses <small>{contacts.length || ""}</small>
          </button>
        </li>
        {isExtension && (
          <li>
            <button onClick={() => setView("sites")}>
              Connected sites <small>{Object.keys(sites).length || ""}</small>
            </button>
          </li>
        )}
      </ul>
      <h4 className="group">Security</h4>
      <ul className="menu">
        <li>
          <button onClick={() => setView("phrase")}>{secrets.key ? "Show private key" : "Show recovery phrase"}</button>
        </li>
        <li>
          <button onClick={() => setView("twostep")}>
            Two-step unlock <small>{secrets.totp ? "On" : "Off"}</small>
          </button>
        </li>
        <li>
          <label>
            Lock automatically after
            <select value={settings.autoLockMinutes} onChange={(e) => saveSettings({ autoLockMinutes: Number(e.target.value) }).then(() => store.remember(secrets))}>
              {[5, 15, 60, 240].map((m) => (
                <option key={m} value={m}>
                  {m < 60 ? `${m} minutes` : `${m / 60} hour${m > 60 ? "s" : ""}`}
                </option>
              ))}
            </select>
          </label>
        </li>
        <li>
          <button className="plain" onClick={onLock}>Lock wallet now</button>
        </li>
      </ul>
      <h4 className="group">Display</h4>
      <ul className="menu">
        <li>
          <label>
            Appearance
            <select value={settings.theme} onChange={(e) => saveSettings({ theme: e.target.value as Settings["theme"] })}>
              <option value="system">Same as device</option>
              <option value="light">Light</option>
              <option value="dark">Dark</option>
            </select>
          </label>
        </li>
        <li>
          <label>
            Hide amounts
            <input type="checkbox" checked={settings.hideBalance} onChange={(e) => saveSettings({ hideBalance: e.target.checked })} />
          </label>
        </li>
      </ul>
      <h4 className="group">Privacy</h4>
      <ul className="menu">
        <li>
          <label>
            Check Ethereum automatically
            <input type="checkbox" checked={settings.ethereum} onChange={(e) => saveSettings({ ethereum: e.target.checked })} />
          </label>
          <p className="small muted">On by default, so ETH and wPRL show on the home screen. When on, the home screen and Activity read your Ethereum address through public servers (Ethereum nodes and Blockscout), which see your IP address. Turn it off to read Ethereum only when you open Swap, Bridge, Buy with USDT or Receive ETH.</p>
        </li>
      </ul>
      <h4 className="group">Advanced</h4>
      <ul className="menu">
        <li>
          <label>
            Network
            <select value={settings.network} onChange={(e) => saveSettings({ network: e.target.value as Settings["network"] })}>
              <option value="mainnet">Pearl mainnet</option>
              <option value="testnet">Testnet (practice coins)</option>
            </select>
          </label>
        </li>
        {(["exchange", "bigone"] as const).map(
          (k) =>
            secrets[k] && (
              <li key={k}>
                <button
                  className="plain"
                  onClick={() => setRemoving(k)}
                >
                  Disconnect {k === "bigone" ? "BigONE" : "SafeTrade"}
                </button>
              </li>
            ),
        )}
      </ul>
      <h4 className="group">Support</h4>
      <ul className="menu">
        <li>
          <button className="plain" onClick={() => copy(SUPPORT_EMAIL, "support")}>
            Support address <small>{copied === "support" ? "Copied" : SUPPORT_EMAIL}</small>
          </button>
        </li>
      </ul>
      <p className="muted small pad">
        Something not working, or an idea to make Keshi better? Write to us. Keshi will never ask for your recovery phrase, private key or password: never send them to anyone.
      </p>
      <p className="muted small pad">Keshi {KESHI_VERSION}. Made for the Pearl community.</p>
    </>
  );
}

function Wallets({ secrets, setSecrets, settings, saveSettings, onClose }: { secrets: core.Secrets; setSecrets: (s: core.Secrets) => void; settings: Settings; saveSettings: (p: Partial<Settings>) => Promise<void>; onClose: () => void }) {
  const net = core.networkById(settings.network);
  const list = core.walletsOf(secrets);
  const active = Math.min(settings.wallet ?? 0, list.length - 1);
  const [mode, setMode] = useState<"phrase" | "key" | "new" | "account" | "remove" | null>(null);
  const [notice, setNotice] = useState("");
  const [renaming, setRenaming] = useState<number | null>(null);
  const [newName, setNewName] = useState("");
  const rename = async () => {
    if (renaming === null) return;
    setError("");
    try {
      setSecrets(await store.renameWallet(secrets, renaming, newName));
      setRenaming(null);
    } catch (e) {
      setError(errText(e));
    }
  };
  const [name, setName] = useState("");
  const [text, setText] = useState("");
  const [pw, setPw] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [created, setCreated] = useState("");
  const [createdChecked, setCreatedChecked] = useState(false);
  // A new wallet is written down and checked BEFORE it is saved, like the first one: nothing is kept if the window closes meanwhile.
  const [createdStep, setCreatedStep] = useState<"words" | "check" | "password">("words");
  const [createdSaved, setCreatedSaved] = useState(false);
  const [createdAnswers, setCreatedAnswers] = useState<Record<number, string>>({});
  const createdQuiz = useMemo(() => {
    const n = created ? created.split(" ").length : 0;
    const picks = new Set<number>();
    if (n) {
      const rnd = new Uint32Array(8);
      crypto.getRandomValues(rnd);
      for (const r of rnd) if (picks.size < 3) picks.add(r % n);
    }
    return [...picks].sort((a, b) => a - b);
  }, [created]);
  const address = (i: number) => {
    try {
      return short(core.accountOf(core.selectWallet(secrets, i), net).derive(false, 0).address, 6);
    } catch {
      return "";
    }
  };

  const add = async () => {
    setError("");
    setNotice("");
    setBusy(true);
    try {
      const label = name.trim() || `Wallet ${list.length + 1}`;
      let entry: core.WalletEntry | core.WalletEntry[];
      let fresh = "";
      let note = "";
      if (mode === "key") entry = { name: label, key: Array.from(core.parsePrivateKey(text), (b) => b.toString(16).padStart(2, "0")).join("") };
      else if (mode === "phrase") {
        if (!core.isValidPhrase(text)) throw new Error("That recovery phrase is not valid. Check the spelling and the order of the words.");
        // Accounts this phrase already used elsewhere come along, so that their funds show up too.
        const { entries, found } = await store.phraseEntries(label, text, true);
        entry = entries;
        if (found === null) note = "Keshi could not check whether this phrase has other accounts in use. You can add them from this screen.";
        else if (found.length) note = `Also added ${found.length === 1 ? "account" : "accounts"} ${found.map((a) => a + 1).join(", ")} of this phrase: ${found.length === 1 ? "it was" : "they were"} used before.`;
      } else {
        // Random enough to be this user's alone; a used one (never seen in practice) is thrown away.
        let tries = 0;
        let unused: boolean | null = null;
        do {
          fresh = core.newPhrase(24);
          unused = await core.phraseIsUnused(fresh);
        } while (unused === false && ++tries < 5);
        if (unused === false) throw new Error("Keshi could not make a fresh wallet. Try again.");
        setCreatedChecked(unused === true);
        setCreatedStep("words");
        setCreatedSaved(false);
        setCreatedAnswers({});
        setCreated(fresh); // shown, checked, then saved by saveCreated
        return;
      }
      const next = await store.importWallet(secrets, entry, pw);
      setSecrets(next);
      // The wallet just imported is put in use: with its accounts, the first one.
      await saveSettings({ wallet: list.length });
      setText("");
      setPw("");
      setName("");
      setMode(null);
      setNotice(note);
      void fresh;
    } catch (e) {
      setError(errText(e) === "Wrong password" ? "Wrong wallet password" : errText(e));
    } finally {
      setBusy(false);
    }
  };

  /** The last step of a new wallet: its words were written down and checked, now it is saved and put in use. */
  const saveCreated = async () => {
    setError("");
    setBusy(true);
    try {
      const label = name.trim() || `Wallet ${list.length + 1}`;
      const next = await store.importWallet(secrets, { name: label, phrase: created, derivation: "pearl" }, pw);
      setSecrets(next);
      await saveSettings({ wallet: list.length });
      setPw("");
      setName("");
      setMode(null);
      setCreated("");
      setNotice(`${label} was created and is in use.`);
    } catch (e) {
      setError(errText(e) === "Wrong password" ? "Wrong wallet password" : errText(e));
    } finally {
      setBusy(false);
    }
  };

  const nextAccount = (() => {
    try {
      return core.nextAccountNumber(secrets, active);
    } catch {
      return null; // a private-key wallet has no other account
    }
  })();

  const addAccount = async () => {
    setError("");
    setNotice("");
    setBusy(true);
    try {
      const next = await store.addAccount(secrets, active, pw);
      setSecrets(next);
      await saveSettings({ wallet: core.walletsOf(next).length - 1 });
      setPw("");
      setMode(null);
    } catch (e) {
      setError(errText(e) === "Wrong password" ? "Wrong wallet password" : errText(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setError("");
    setNotice("");
    setBusy(true);
    try {
      const gone = list[active]!.name;
      const next = await store.removeWallet(active, pw);
      setSecrets(next);
      await saveSettings({ wallet: 0 });
      setPw("");
      setMode(null);
      setNotice(`${gone} was removed from Keshi.`);
    } catch (e) {
      setError(errText(e) === "Wrong password" ? "Wrong wallet password" : errText(e));
    } finally {
      setBusy(false);
    }
  };

  if (created && createdStep === "words")
    return (
      <>
        <Header title="Your new recovery phrase" onBack={() => setCreated("")} />
        <p className="muted">Write these 24 words on paper, in order. They are the only way to get this wallet back. It is not saved yet: Keshi saves it after you have checked your copy.</p>
        <ol className="words">
          {created.split(" ").map((w, i) => (
            <li key={i}>{w}</li>
          ))}
        </ol>
        {createdChecked && <p className="fresh small">Checked on the Pearl network: this wallet has never been used. Its words were made on this device and nowhere else.</p>}
        <label className="check">
          <input type="checkbox" checked={createdSaved} onChange={(e) => setCreatedSaved(e.target.checked)} />
          <span>I wrote the words down and stored them somewhere safe</span>
        </label>
        <button className="btn primary" disabled={!createdSaved} onClick={() => setCreatedStep("check")}>
          Continue
        </button>
      </>
    );
  if (created && createdStep === "check") {
    const words = created.split(" ");
    const ok = createdQuiz.every((i) => (createdAnswers[i] ?? "").trim().toLowerCase() === words[i]);
    return (
      <>
        <Header title="Check your copy" onBack={() => setCreatedStep("words")} />
        <p className="muted">Type these three words from your paper copy.</p>
        {createdQuiz.map((i) => (
          <label className="field" key={i}>
            <span>Word {i + 1}</span>
            <input autoComplete="off" spellCheck={false} value={createdAnswers[i] ?? ""} onChange={(e) => setCreatedAnswers({ ...createdAnswers, [i]: e.target.value })} />
          </label>
        ))}
        <button className="btn primary" disabled={!ok} onClick={() => setCreatedStep("password")}>
          Continue
        </button>
      </>
    );
  }
  if (created && createdStep === "password")
    return (
      <>
        <Header title="Save the new wallet" onBack={() => setCreatedStep("check")} />
        <p className="muted">Your copy is checked. Enter your Keshi password to add this wallet to your vault.</p>
        <label className="field">
          <span>Wallet password</span>
          <input type="password" value={pw} autoFocus onChange={(e) => setPw(e.target.value)} onKeyDown={(e) => e.key === "Enter" && saveCreated()} />
        </label>
        {error && <p className="error">{error}</p>}
        <button className="btn primary" disabled={busy || !pw} onClick={saveCreated}>
          {busy ? "Saving…" : "Save wallet"}
        </button>
      </>
    );

  return (
    <>
      <Header title="Wallets" onBack={onClose} />
      <ul className="list wallets">
        {list.map((w, i) =>
          renaming === i ? (
            <li key={i} className="renaming">
              <input
                value={newName}
                maxLength={24}
                autoFocus
                aria-label="Wallet name"
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void rename();
                  if (e.key === "Escape") setRenaming(null);
                }}
              />
              <button className="btn primary small" disabled={!newName.trim()} onClick={rename}>
                Save
              </button>
              <button className="link" onClick={() => setRenaming(null)}>
                Cancel
              </button>
            </li>
          ) : (
            <li key={i} className="with-action">
              <button onClick={() => saveSettings({ wallet: i })} aria-pressed={i === active}>
                <span className={`dot ${i === active ? "in" : "out"}`} aria-hidden="true" />
                <span className="main">
                  <span>{w.name}</span>
                  <small>
                    {address(i)}, {w.key ? "private key" : core.accountNumber(w) > 0 ? `account ${core.accountNumber(w) + 1}` : "recovery phrase"}
                    {i === active ? " · In use" : ""}
                  </small>
                </span>
              </button>
              <button
                className="link rename"
                aria-label={`Rename ${w.name}`}
                onClick={() => {
                  setError("");
                  setNewName(w.name);
                  setRenaming(i);
                }}
              >
                Rename
              </button>
            </li>
          ),
        )}
      </ul>
      {notice && <p className="fresh small">{notice}</p>}
      <div className="wallet-actions">
        {nextAccount !== null && (
          <button className="link" onClick={() => { setError(""); setMode(mode === "account" ? null : "account"); }}>
            Add an account to {core.phraseName(secrets, active)}
          </button>
        )}
        {list.length > 1 && (
          <button className="link" onClick={() => { setError(""); setMode(mode === "remove" ? null : "remove"); }}>
            Remove {list[active]!.name}
          </button>
        )}
      </div>
      {mode === "account" && nextAccount !== null && (
        <div className="card stack">
          <p className="muted small">
            A recovery phrase holds many accounts, each with its own addresses, history and Ethereum address. This adds account {nextAccount + 1} of the phrase of {core.phraseName(secrets, active)}, numbered the standard way, so
            another wallet restoring the same phrase finds it under the same number. It can be renamed afterwards.
          </p>
          <label className="field">
            <span>Wallet password</span>
            <input type="password" value={pw} autoFocus onChange={(e) => setPw(e.target.value)} onKeyDown={(e) => e.key === "Enter" && addAccount()} />
          </label>
          {error && <p className="error">{error}</p>}
          <button className="btn primary" disabled={busy || !pw} onClick={addAccount}>
            {busy ? "Saving…" : `Add account ${nextAccount + 1}`}
          </button>
        </div>
      )}
      {mode === "remove" && list.length > 1 && (
        <div className="card stack">
          {core.phraseKeptElsewhere(secrets, active) ? (
            <p className="muted small">
              {list[active]!.name} will leave this list. Its recovery phrase stays in Keshi with its other accounts, so this account can be added again later. Nothing moves on the
              network.
            </p>
          ) : (
            <p className="muted small">
              Keshi will forget {list[active]!.name} on this device, and disconnect the sites it was connected to. Nothing moves on the network: the funds stay on its addresses, and only
              its {list[active]!.key ? "private key" : "recovery phrase"} can bring them back. Make sure you have it written down before you continue.
            </p>
          )}
          <label className="field">
            <span>Wallet password</span>
            <input type="password" value={pw} autoFocus onChange={(e) => setPw(e.target.value)} onKeyDown={(e) => e.key === "Enter" && remove()} />
          </label>
          {error && <p className="error">{error}</p>}
          <button className="btn primary" disabled={busy || !pw} onClick={remove}>
            {busy ? "Removing…" : `Remove ${list[active]!.name}`}
          </button>
        </div>
      )}
      <h3>Import a wallet</h3>
      <div className="seg">
        <button className={mode === "phrase" ? "on" : ""} onClick={() => setMode("phrase")}>
          Recovery phrase
        </button>
        <button className={mode === "key" ? "on" : ""} onClick={() => setMode("key")}>
          Private key
        </button>
        <button className={mode === "new" ? "on" : ""} onClick={() => setMode("new")}>
          New wallet
        </button>
      </div>
      {mode && mode !== "account" && mode !== "remove" && (
        <>
          <label className="field">
            <span>Name</span>
            <input value={name} placeholder={`Wallet ${list.length + 1}`} onChange={(e) => setName(e.target.value)} />
          </label>
          {mode !== "new" && (
            <label className="field">
              <span>{mode === "phrase" ? "12 or 24 word recovery phrase" : "Private key (64 hex characters or WIF)"}</span>
              <textarea rows={mode === "phrase" ? 4 : 2} autoComplete="off" spellCheck={false} value={text} onChange={(e) => setText(e.target.value)} />
            </label>
          )}
          {mode === "key" && <p className="muted small">A private-key wallet has a single address. Keep the key somewhere safe: Keshi cannot recover it.</p>}
          {mode === "new" && <p className="muted small">Keshi shows the new words first, checks your copy, then asks your password to save the wallet.</p>}
          {mode !== "new" && (
            <label className="field">
              <span>Wallet password</span>
              <input type="password" value={pw} onChange={(e) => setPw(e.target.value)} onKeyDown={(e) => e.key === "Enter" && add()} />
            </label>
          )}
          {error && <p className="error">{error}</p>}
          <button className="btn primary" disabled={busy || (mode !== "new" && (!pw || !text.trim()))} onClick={add}>
            {busy ? (mode === "new" ? "Making…" : "Saving…") : mode === "new" ? "Create wallet" : "Import wallet"}
          </button>
        </>
      )}
    </>
  );
}

function ShowPhrase({ index, onClose }: { index: number; onClose: () => void }) {
  const [keyText, setKeyText] = useState("");
  const [code, setCode] = useState("");
  const [pw, setPw] = useState("");
  const [phrase, setPhrase] = useState("");
  const [account, setAccount] = useState(0);
  const [error, setError] = useState("");
  const reveal = async () => {
    try {
      // Same wrong-password delay as the unlock screen: this screen must not allow guessing the password either.
      const s = await store.revealSecrets(pw, code);
      const w = core.selectWallet(s, index);
      if (w.key) setKeyText(w.key);
      else setPhrase(w.phrase);
      setAccount(core.accountNumber(w));
      // Do not leave secrets on screen: hide them again after a minute.
      setTimeout(() => {
        setKeyText("");
        setPhrase("");
        setPw("");
      }, 60_000);
    } catch (e) {
      setError(errText(e));
    }
  };
  return (
    <>
      <Header title={keyText ? "Private key" : "Recovery phrase"} onBack={onClose} />
      {keyText ? (
        <p className="addr left">{keyText}</p>
      ) : !phrase ? (
        <>
          <p className="muted">Make sure nobody can see your screen. Keshi support will never ask for these words.</p>
          <label className="field">
            <span>Wallet password</span>
            <input type="password" value={pw} autoFocus onChange={(e) => setPw(e.target.value)} onKeyDown={(e) => e.key === "Enter" && reveal()} />
          </label>
          {error && (error === store.CODE_NEEDED || error === "Wrong code" || code) && (
            <label className="field">
              <span>Code from your authenticator app</span>
              <input inputMode="numeric" placeholder="000000" maxLength={7} value={code} onChange={(e) => setCode(e.target.value)} onKeyDown={(e) => e.key === "Enter" && reveal()} />
            </label>
          )}
          {error && <p className="error">{error}</p>}
          <button className="btn primary" disabled={!pw} onClick={reveal}>
            Show phrase
          </button>
        </>
      ) : (
        <>
          {account > 0 && <p className="muted small">This wallet is account {account + 1} of these words. The words are the same for every account of the phrase; the account number is what tells them apart.</p>}
          <ol className="words">
            {phrase.split(" ").map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ol>
        </>
      )}
    </>
  );
}

function TwoStep({ secrets, setSecrets, onClose }: { secrets: core.Secrets; setSecrets: (s: core.Secrets) => void; onClose: () => void }) {
  const on = !!secrets.totp;
  const [secret] = useState(() => core.newTotpSecret());
  const [svg, setSvg] = useState("");
  const [code, setCode] = useState("");
  const [pw, setPw] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [copied, copy] = useCopy();
  useEffect(() => {
    if (!on) QRCode.toString(core.totpUri(secret), { type: "svg", margin: 0, errorCorrectionLevel: "M" }).then(setSvg);
  }, [on, secret]);
  const save = async () => {
    setError("");
    const active = on ? secrets.totp! : secret;
    if (!core.verifyTotp(active, code)) return setError("That code is not right. Check the app and try again.");
    setBusy(true);
    try {
      setSecrets(
        await store.saveSecrets((s) => {
          const next = { ...s };
          if (on) delete next.totp;
          else next.totp = secret;
          return next;
        }, pw),
      );
      onClose();
    } catch (e) {
      setError(errText(e) === "Wrong password" ? "Wrong wallet password" : errText(e));
      setBusy(false);
    }
  };
  return (
    <>
      <Header title="Two-step unlock" onBack={onClose} />
      {on ? (
        <p className="muted">Two-step unlock is on. To turn it off, enter a code from your authenticator app and your wallet password.</p>
      ) : (
        <>
          <p className="muted">
            Keshi will ask for a 6-digit code from an authenticator app (Google Authenticator, Authy, 1Password) each time you unlock or show your recovery phrase.
          </p>
          <QrImage svg={svg} />
          <p className="muted small">Cannot scan? Type this setup key into the app:</p>
          <p className="addr setup-key">{secret.replace(/(.{4})/g, "$1 ").trim()}</p>
          <button className="link" onClick={() => copy(secret, secret, true)}>
            {copied ? "Copied (cleared from the clipboard after 30 s)" : "Copy the setup key"}
          </button>
          <p className="muted small">
            If you lose the authenticator, restore the wallet with your recovery phrase. This is an extra check at the door, not a second key: it stops someone who knows your password from opening Keshi on this device through its screens. It does not protect a copy of your browser files whose password is known, nor against malware, and your recovery phrase remains the master key.
          </p>
        </>
      )}
      <label className="field">
        <span>6-digit code</span>
        <input inputMode="numeric" placeholder="000000" maxLength={7} value={code} onChange={(e) => setCode(e.target.value)} />
      </label>
      <label className="field">
        <span>Wallet password</span>
        <input type="password" value={pw} onChange={(e) => setPw(e.target.value)} onKeyDown={(e) => e.key === "Enter" && save()} />
      </label>
      {error && <p className="error">{error}</p>}
      <button className="btn primary" disabled={busy || !pw || code.replace(/\s/g, "").length < 6} onClick={save}>
        {busy ? "Saving…" : on ? "Turn off two-step unlock" : "Turn on two-step unlock"}
      </button>
    </>
  );
}

function Contacts({ net, contacts, onClose }: { net: core.Network; contacts: Contact[]; onClose: () => void }) {
  const [list, setList] = useState(contacts);
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const [error, setError] = useState("");
  useEffect(() => setList(contacts), [contacts]);
  const save = async (next: Contact[]) => {
    setList(next);
    await local.set("contacts", next);
  };
  const add = () => {
    if (!name.trim()) return setError("Give the contact a name");
    if (!core.isValidAddress(address.trim(), net)) return setError(`That is not a valid ${net.hrp}1… address`);
    setError("");
    save([...list, { name: name.trim(), address: address.trim() }]);
    setName("");
    setAddress("");
  };
  return (
    <>
      <Header title="Saved addresses" onBack={onClose} />
      <p className="muted small">People you pay often. They appear as shortcuts when you send.</p>
      <ul className="list plain">
        {list.map((c) => (
          <li key={c.address}>
            <span className="main">
              <span>{c.name}</span>
              <small>{short(c.address, 10)}</small>
            </span>
            <button className="link" onClick={() => save(list.filter((x) => x.address !== c.address))}>
              Remove
            </button>
          </li>
        ))}
      </ul>
      <label className="field">
        <span>Name</span>
        <input value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <label className="field">
        <span>Address</span>
        <input value={address} spellCheck={false} placeholder={`${net.hrp}1…`} onChange={(e) => setAddress(e.target.value)} />
      </label>
      {error && <p className="error">{error}</p>}
      <button className="btn" onClick={add}>
        Add contact
      </button>
    </>
  );
}

/* -------------------------------------------------- Site approval window */

/** Make invisible and direction-changing characters show, so a message cannot hide text. */
const visible = (text: string): string => text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);

function Approve({ id, secrets, settings }: { id: string; secrets: core.Secrets; settings: Settings }) {
  const net = core.networkById(settings.network);
  const [req, setReq] = useState<DappRequest | null | undefined>(undefined);
  const [snap, setSnap] = useState<core.Snapshot | null>(null);
  const [planned, setPlanned] = useState<core.Plan | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const answered = useRef(false);
  const account = useMemo(() => core.accountOf(secrets, net), [secrets, net.id]);
  const me = useMemo(() => account.derive(false, 0), [account]);

  const [known, setKnown] = useState<string[]>([]);
  const [ack, setAck] = useState(false);
  // The buttons wake up a moment after the window appears, so a click meant for the page cannot land on them.
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setArmed(true), 900);
    return () => clearTimeout(t);
  }, []);

  useEffect(() => {
    if (!/^[0-9a-f-]{36}$/.test(id)) return setReq(null);
    session.get<DappRequest>("req:" + id).then((r) => setReq(r && typeof r.origin === "string" ? r : null));
  }, [id]);

  useEffect(() => {
    if (req?.method !== "sendPayment") return;
    (async () => {
      try {
        const s = await store.refresh(secrets, net);
        setSnap(s);
        store.knownAddresses(s).then(setKnown);
        const amount = parsePrl(String(req.params.amount));
        if (amount === null) throw new Error("The site asked for an invalid amount");
        setPlanned(core.plan(s, net, req.params.to, amount, await new core.Indexer(net).feeRate(3), core.serviceFor(net, "send")));
      } catch (e) {
        setError(errText(e));
      }
    })();
  }, [req]);

  const answer = async (result?: unknown, err?: string) => {
    if (!req || answered.current) return;
    answered.current = true;
    // Answer first, then forget: if this window dies in between, the background still rejects for it.
    if (isExtension) await chrome.tabs.sendMessage(req.tabId, { keshi: "response", id: req.pageId, origin: req.origin, result, error: err }).catch(() => {});
    // A refused connection: the same site may not ask again for a minute.
    if (err && req.method === "connect") await session.set("cool:" + req.origin, Date.now() + 60_000);
    await session.remove("req:" + req.id);
    window.close();
  };

  const approve = async () => {
    if (!req) return;
    setBusy(true);
    setError("");
    try {
      // The wallet may have locked itself while this window was open.
      if (!(await store.stillUnlocked())) throw new Error("Keshi is locked. Close this window, unlock Keshi and ask the site again.");
      // The site may have been told "no" already (window reopened, request expired).
      if (Date.now() - req.at > 10 * 60_000 || !(await session.get("req:" + req.id))) throw new Error("This request has expired. Close this window and ask the site again.");
      if (req.method !== "connect") {
        // Only the wallet the site was connected to may answer it, and only while the site is still connected.
        const sites = (await local.get<Record<string, Site>>("sites")) ?? {};
        const site = Object.prototype.hasOwnProperty.call(sites, req.origin) ? sites[req.origin] : undefined;
        if (!site) throw new Error("This site is no longer connected. Close this window.");
        if (site.address !== me.address) throw new Error("This site is connected to another of your wallets. Switch to that wallet in Keshi, then ask the site again.");
      }
      if (req.method === "connect") {
        const publicKey = Array.from(me.pubkey, (b) => b.toString(16).padStart(2, "0")).join("");
        const sites = (await local.get<Record<string, Site>>("sites")) ?? {};
        sites[req.origin] = { address: me.address, publicKey, since: Date.now() };
        await local.set("sites", sites);
        await answer({ address: me.address, publicKey });
      } else if (req.method === "signMessage") {
        await answer({ address: me.address, signature: core.signMessage(req.params.message, me.address, account.privateKey(false, 0), me.pubkey, net) });
      } else if (planned && snap) {
        await answer({ txid: await store.pay(secrets, net, snap, planned) });
      }
    } catch (e) {
      setError(errText(e));
      setBusy(false);
    }
  };

  if (req === undefined) return <div className="screen" />;
  if (req === null)
    return (
      <div className="screen">
        <p className="muted pad">This request has expired. You can close this window.</p>
      </div>
    );
  const host = req.origin.replace(/^https?:\/\//, "");
  return (
    <div className="screen">
      <header className="head">
        <Mark size={22} />
        <span className="wordmark">Keshi</span>
      </header>
      <p className="origin">{host}</p>
      {req.method === "connect" && (
        <>
          <h2 className="ask">wants to connect to your wallet</h2>
          <p className="muted">It will see your address and balance. It cannot move your PRL: every payment and signature still needs your approval here.</p>
          <dl className="rows">
            <Row k="Address shared" v={short(me.address, 10)} />
          </dl>
        </>
      )}
      {req.method === "signMessage" && (
        <>
          <h2 className="ask">asks you to sign a message</h2>
          <p className="muted">Signing proves you own this wallet. It does not move any PRL. Only sign text you understand.</p>
          <pre className="message">{visible(String(req.params.message))}</pre>
          {core.foreignSites(String(req.params.message), req.origin).length > 0 && (
            <p className="hint warn">
              This message mentions {core.foreignSites(String(req.params.message), req.origin).join(", ")}, but the request comes from {host}. A site can use your signature to sign in somewhere else as you. Only sign if you trust both.
            </p>
          )}
          {String(req.params.message).length > 300 && <p className="muted small">This is a long message. Scroll to read all of it before you sign.</p>}
          <dl className="rows">
            <Row k="Signing with" v={short(me.address, 10)} />
          </dl>
        </>
      )}
      {req.method === "sendPayment" && (
        <>
          <h2 className="ask">asks you to send a payment</h2>
          <p className="hero-amt">
            {planned ? formatPrl(planned.amount) : "…"} <small>PRL</small>
          </p>
          <dl className="rows">
            <Row k="To" v={<Addr value={String(req.params.to)} className="mono-wrap addr-in" />} />
            <Row k="Network fee" v={planned ? `${formatPrl(planned.fee)} PRL` : error ? "—" : "Calculating…"} />
            {planned && planned.serviceFee > 0n && <Row k={`Keshi fee (${planned.serviceLabel})`} v={`${formatPrl(planned.serviceFee)} PRL`} />}
            {planned && <Row k="Total leaving your wallet" v={`${formatPrl(planned.amount + planned.fee + planned.serviceFee)} PRL`} />}
            <Row k="Paying from" v={`${short(me.address, 8)}${net.id === "testnet" ? " (testnet)" : ""}`} />
          </dl>
          {planned && core.lookalikeOf(planned.to, known) && (
            <p className="hint warn">This address looks like {short(core.lookalikeOf(planned.to, known)!, 6)}, which you have used before, but it is a different address. Check every character.</p>
          )}
          {planned && !known.includes(planned.to) && <p className="muted small">First payment to this address. Payments cannot be reversed.</p>}
          {snap && snap.protectionChecked === false && (
            <label className="check">
              <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
              <span>The token index is unreachable. Coins Keshi already knew carry tokens stay aside, but it cannot check newer ones. I received no token coin larger than 0.0005 PRL since the last check.</span>
            </label>
          )}
        </>
      )}
      {error && <p className="error">{error}</p>}
      <div className="grow" />
      <div className="actions">
        <button className="btn" disabled={busy} onClick={() => answer(undefined, "The user rejected the request")}>
          Reject
        </button>
        <button className="btn primary" disabled={busy || !armed || (req.method === "sendPayment" && (!planned || (snap?.protectionChecked === false && !ack)))} onClick={approve}>
          {busy ? "Working…" : req.method === "connect" ? "Connect" : req.method === "signMessage" ? "Sign" : "Send payment"}
        </button>
      </div>
    </div>
  );
}

/* ---------------------------------------- Ethereum: ETH and wPRL, sending, first ETH */

/**
 * What to do when the Ethereum address is short of ETH for fees. Every
 * Ethereum step (swap, bridge back, Uniswap, send) is paid in ETH, and the
 * first ETH always comes from outside Keshi.
 */
function GetEth({ lead, address, shown = false, label = "Receive ETH" }: { lead: ReactNode; address: string; shown?: boolean; label?: string }) {
  const [show, setShow] = useState(shown);
  return (
    <div className="hint warn get-eth">
      <p>{lead}</p>
      <details className="how">
        <summary>How to get ETH</summary>
        <ul>
          <li>
            <b>From another wallet or an exchange account:</b> send ETH on the Ethereum network to your Ethereum address in Keshi.
          </li>
          <li>
            <b>Buy some:</b> buy ETH on an exchange such as{" "}
            <a href="https://big.one" target="_blank" rel="noreferrer noopener">
              BigONE
            </a>
            , then withdraw it to your Ethereum address in Keshi. Choose the Ethereum (ERC-20) network when you withdraw.
          </li>
        </ul>
      </details>
      {!shown && (
        <button className="btn" onClick={() => setShow(!show)}>
          {show ? "Hide my Ethereum address" : label}
        </button>
      )}
      {show && <EthAddressCard address={address} />}
    </div>
  );
}

/** Today's ETH price in dollars: CoinGecko first, Uniswap's own pool when CoinGecko is busy. */
let ethUsdCache: { at: number; price: number } | null = null;
async function ethUsdNow(): Promise<number | null> {
  // One answer serves every screen for 5 minutes: CoinGecko's free tier refuses frequent calls.
  if (ethUsdCache && Date.now() - ethUsdCache.at < 5 * 60_000) return ethUsdCache.price;
  const g = await new core.MarketData().ethPrice().catch(() => null);
  const price = g ?? (await core.ethUsdOnUniswap(new core.EthRpc()).catch(() => null));
  if (price) ethUsdCache = { at: Date.now(), price };
  return price;
}

type EthAssetName = "ETH" | "wPRL";

/** One Ethereum asset of the wallet: what it is, how much, and what can be done with it. */
function EthAsset({ asset, secrets, price, open, onClose }: Ctx & { asset: EthAssetName; open: (s: Sheet) => void; onClose: () => void }) {
  const [hold, setHold] = useState<store.EthHoldings | null>(null);
  const [ethUsd, setEthUsd] = useState<number | null>(null);
  const [showAddr, setShowAddr] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    store.ethHoldings(secrets).then(setHold).catch(() => setError("Could not reach Ethereum just now."));
    ethUsdNow().then(setEthUsd);
  }, [secrets]);
  const amount = hold ? (asset === "ETH" ? hold.eth : hold.wprl) : null;
  const value = amount === null ? null : asset === "ETH" ? (ethUsd ? (Number(amount) / 1e18) * ethUsd : null) : price ? prlToNumber(amount) * price : null;
  return (
    <div className="screen">
      <Header title={asset} onBack={onClose} />
      <div className="asset-hero">
        <Coin name={asset} native />
        <p className="hero-amt">
          {amount === null ? "···" : asset === "ETH" ? fmtEth(amount) : formatPrl(amount, 4)} <small>{asset}</small>
        </p>
      </div>
      {value !== null && <p className="muted">{usd(value)}</p>}
      <p className="muted small">
        {asset === "ETH"
          ? "ETH lives on your Ethereum address in Keshi. It pays every Ethereum fee: bridging wPRL back to Pearl, swaps and sends."
          : "wPRL is PRL on Ethereum, one for one. Bring it back to Pearl as PRL with the bridge, swap it for ETH, or send it to another Ethereum address."}
      </p>
      {error && <p className="error">{error}</p>}
      <div className="actions">
        <button className="btn primary" disabled={!hold} onClick={() => open({ kind: "ethsend", asset })}>
          Send
        </button>
        <button className="btn" disabled={!hold} onClick={() => setShowAddr(!showAddr)}>
          {showAddr ? "Hide address" : "Receive"}
        </button>
      </div>
      {asset === "wPRL" && (
        <button className="btn" onClick={() => open({ kind: "bridge" })}>
          Bridge wPRL to PRL
        </button>
      )}
      {showAddr && hold && <EthAddressCard address={hold.address} />}
    </div>
  );
}

/* ------------------------------------------------- Buy with USDT elsewhere */

/**
 * USDT held on Arbitrum, BNB Chain or Polygon becomes wPRL on the wallet's
 * Ethereum address through LI.FI, in one signed transaction on the source
 * chain (two when a permission is needed). A second, smaller purchase can bring
 * a little ETH at the same time, so the return to PRL through the bridge can
 * be paid. Keshi never holds the money.
 */
/** How a USDT purchase ended, as remembered once LI.FI said so. */
const OUTCOME: Record<NonNullable<store.UsdtPurchase["outcome"]>, string> = {
  arrived: "Arrived on your Ethereum address.",
  partial: "Arrived only in part: less than quoted was delivered. Check Details.",
  refunded: "Refunded on the source chain. Check Details for the amount returned.",
  failed: "Failed. Check Details: a refund is not automatic in every case.",
};

function UsdtBuy({ secrets, net, snap, price, open, onClose, settings, saveSettings, embedded = false }: Ctx & { open: (s: Sheet) => void; onClose?: () => void; embedded?: boolean }) {
  const [chainId, setChainId] = useState<core.SourceChain["id"]>("arbitrum");
  const chain = core.sourceChain(chainId);
  const [src, setSrc] = useState<{ address: string; usdt: bigint; gas: bigint } | null>(null);
  const [srcError, setSrcError] = useState("");
  const [hold, setHold] = useState<store.EthHoldings | null>(null);
  const [ethUsd, setEthUsd] = useState<number | null>(null);
  const [ethNeed, setEthNeed] = useState<bigint | null>(null);
  const [amount, setAmount] = useState("");
  const [withEth, setWithEth] = useState(true);
  const [quotes, setQuotes] = useState<{ wprl: core.LifiQuote; eth: core.LifiQuote | null } | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState("");
  const [error, setError] = useState("");
  const [sent, setSent] = useState<{ wprl: string; eth?: string } | null>(null);
  const [purchases, setPurchases] = useState<store.UsdtPurchase[]>([]);
  const [status, setStatus] = useState<Record<string, core.LifiStatus>>({});
  const [showAddr, setShowAddr] = useState(false);
  const dec = chain.usdt.decimals;
  const fmtUsdt = (v: bigint) => core.formatUnits(v, dec, 2);
  const typed = core.parseUnits(amount.replace(",", "."), dec);

  useEffect(() => {
    store.ethHoldings(secrets).then(setHold).catch(() => {});
    ethUsdNow().then(setEthUsd);
    core.bridgeBackEthNeeded(new core.EthRpc()).then(setEthNeed).catch(() => {});
    store.usdtPurchases(core.ethAccountOf(secrets).address).then(setPurchases);
  }, [secrets]);
  useEffect(() => {
    setSrc(null);
    setSrcError("");
    setQuotes(null);
    store.usdtSource(secrets, chain).then(setSrc).catch(() => setSrcError(`Could not reach ${chain.name} just now.`));
  }, [secrets, chainId, sent]);

  // How much ETH the return to PRL will need, beyond what the address already holds, bought with a few USDT.
  const ethShort = hold && ethNeed !== null ? (hold.eth < ethNeed ? ethNeed - hold.eth : 0n) : null;
  const ethUsdtNeeded: bigint | null = ethShort === null || !ethUsd ? null : ethShort === 0n ? 0n : BigInt(Math.ceil(Math.min(30, Math.max(2, (Number(ethShort) / 1e18) * ethUsd * 1.5)))) * 10n ** BigInt(dec);
  const ethLegLarge = !!typed && !!ethUsdtNeeded && ethUsdtNeeded * 5n > typed;
  const ethLeg = withEth && !!ethUsdtNeeded && ethUsdtNeeded > 0n;
  const wprlPart = typed && ethLeg ? typed - ethUsdtNeeded! : typed;
  // A rough figure before any quote, from today's PRL price and Keshi's fee only (LI.FI's own
  // fees and the price move are not in it): what to expect, never what is promised.
  const buyFee = core.usdtBuyFee();
  const roughPrl = wprlPart && wprlPart > 0n && price ? ((Number(wprlPart) / 10 ** dec) * (1 - Number(buyFee?.bips ?? 0n) / 10_000)) / price : null;
  // What a small purchase pays whatever its size, in dollars: the ETH bought for the bridge fee (or, when the
  // address already holds ETH, the ETH the bridge will burn), LI.FI's route costs (about a dollar on these
  // chains), and PearlBridge's minimum of 4 PRL on the way back. The percentage fees (Keshi 0.5% here, 0.1%
  // on the bridge, PearlBridge 0.5%) come on top. Figures are estimates for guidance, not a quote.
  const LIFI_FIXED_USD = 1;
  const BRIDGE_MIN_PRL = 4;
  const PERCENT_FEES = Number(buyFee?.bips ?? 0n) / 10_000 + 0.006;
  const fixedUsd =
    ethUsdtNeeded === null || !price
      ? null
      : (ethUsdtNeeded > 0n ? Number(ethUsdtNeeded) / 10 ** dec : ethNeed && ethUsd ? (Number(ethNeed) / 1e18) * ethUsd : 0) + LIFI_FIXED_USD + BRIDGE_MIN_PRL * price;
  // From this amount, fixed costs stay under 5% of the purchase (rounded up to 10 USDT).
  const suggestedMin = fixedUsd !== null && Number.isFinite(fixedUsd) ? Math.ceil(fixedUsd / (0.05 - PERCENT_FEES) / 10) * 10 : null;
  const typedUsd = typed ? Number(typed) / 10 ** dec : null;
  const fixedShare = fixedUsd !== null && typedUsd ? Math.round((fixedUsd / typedUsd) * 100) : null;

  // Watch each purchase until LI.FI says it arrived: every 8 s for the first
  // minutes, then once a minute, and no longer than two hours, so a stuck one
  // cannot keep asking LI.FI forever (the shared key has a request allowance).
  useEffect(() => {
    const open_ = purchases.filter((p) => !p.done && Date.now() - p.at < 2 * 3600_000);
    if (!open_.length) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const lifi = new core.LiFi();
    const tick = async () => {
      for (const p of open_) {
        const s = await lifi.status(p.txHash, core.sourceChain(p.chain)).catch(() => null);
        if (!alive || !s) continue;
        setStatus((m) => ({ ...m, [p.txHash]: s }));
        const outcome = store.purchaseOutcome(s);
        if (outcome) {
          await store.recordPurchase({ ...p, done: true, outcome });
          if (alive) setPurchases(await store.usdtPurchases(p.from));
        }
      }
      if (!alive) return;
      const youngest = Math.min(...open_.map((p) => Date.now() - p.at));
      timer = setTimeout(tick, youngest < 3 * 60_000 ? 8000 : 60_000);
    };
    void tick();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [purchases.map((p) => p.txHash + (p.done ? "d" : "")).join(",")]);

  const getQuote = async () => {
    setError("");
    setQuotes(null);
    if (!src) return setError(`Still reading your balance on ${chain.name}.`);
    if (!typed || typed <= 0n) return setError("Enter an amount in USDT, for example 50");
    if (typed > src.usdt) return setError(`You have ${fmtUsdt(src.usdt)} USDT on ${chain.name}.`);
    if (ethLeg && wprlPart! <= 10n ** BigInt(dec)) return setError(`Too small: ${fmtUsdt(ethUsdtNeeded!)} USDT of this would go to ETH for fees. Send more, or untick the ETH option.`);
    if (src.gas === 0n) return setError(`Your address on ${chain.name} has no ${chain.gas} to pay that chain's fee. Send a little ${chain.gas} there first (a few cents' worth).`);
    setQuoting(true);
    try {
      if (!settings.ethereum) void saveSettings({ ethereum: true });
      const lifi = new core.LiFi();
      const wprl = await lifi.quote(chain, src.address, wprlPart!, "wprl");
      const eth = ethLeg ? await lifi.quote(chain, src.address, ethUsdtNeeded!, "eth") : null;
      // Second opinion on the price, from the wallet's own feeds against the USDT typed here (one USDT is a dollar):
      // a quote that disagrees by more than 20% is not signed, and without a price of our own nothing is signed at all.
      if (!price) throw new Error("Keshi could not read today's PRL price to check this quote. Nothing was sent; try again in a moment.");
      {
        const paidUsd = Number(wprlPart!) / 10 ** chain.usdt.decimals;
        const implied = prlToNumber(wprl.toAmount) * price;
        if (implied < paidUsd * 0.8) throw new Error(`LI.FI's quote is worth about ${usd(implied)} at today's PRL price, far below the ${usd(paidUsd)} paid. Nothing was sent; try again later.`);
      }
      if (eth) {
        if (!ethUsd) throw new Error("Keshi could not read today's ETH price to check this quote. Nothing was sent; try again in a moment.");
        const paidUsd = Number(ethUsdtNeeded!) / 10 ** chain.usdt.decimals;
        const implied = (Number(eth.toAmount) / 1e18) * ethUsd;
        if (implied < paidUsd * 0.8) throw new Error("LI.FI's ETH quote is far below today's ETH price. Nothing was sent; try again later.");
      }
      setQuotes({ wprl, eth });
    } catch (e) {
      setError(errText(e));
    } finally {
      setQuoting(false);
    }
  };

  const buy = async () => {
    if (!quotes) return;
    if (Date.now() - quotes.wprl.at > core.QUOTE_LIFETIME_MS) {
      setQuotes(null);
      return setError("That quote is more than a minute old. Ask for a fresh one.");
    }
    setBusy(true);
    setError("");
    try {
      const wprlHash = await store.buyWithUsdt(secrets, chain, quotes.wprl, quotes.wprl.fromAmount, setStep);
      let ethHash: string | undefined;
      if (quotes.eth) {
        try {
          // The first purchase must be in a block before the second is prepared: its nonce and the USDT permission depend on it.
          setStep("Waiting for the wPRL purchase to confirm before buying the ETH…");
          const ok = await new core.EthRpc(undefined, chain.rpcs).wait(wprlHash, 180_000, 3000);
          if (!ok) throw new Error("the wPRL purchase was rejected by the network, so the ETH purchase was not attempted");
          if (Date.now() - quotes.eth.at > 5 * core.QUOTE_LIFETIME_MS) throw new Error("its quote expired while the first purchase confirmed");
          ethHash = await store.buyWithUsdt(secrets, chain, quotes.eth, quotes.eth.fromAmount, (t) => setStep(`ETH for fees: ${t}`));
        } catch (e) {
          setError(`Your wPRL purchase went through, but the small ETH purchase did not: ${errText(e)}. You can get ETH another way before bridging back.`);
        }
      }
      setSent({ wprl: wprlHash, eth: ethHash });
      setQuotes(null);
      setAmount("");
      setPurchases(await store.usdtPurchases(core.ethAccountOf(secrets).address));
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
      setStep("");
    }
  };

  const seconds = (n: number) => (n < 90 ? `about ${Math.max(3, Math.round(n))} s` : `about ${Math.round(n / 60)} min`);
  const wprlOut = quotes ? quotes.wprl.toAmount : 0n;
  const wprlMin = quotes ? quotes.wprl.toAmountMin : 0n;

  const body = (
    <>
      {!embedded && <p className="muted small">Your USDT on {chain.name} becomes wPRL on your Ethereum address in Keshi, through LI.FI. You sign on {chain.name}; the money never passes through Keshi or an exchange account.</p>}
      <div className="seg">
        {core.SOURCE_CHAINS.map((c) => (
          <button key={c.id} className={chainId === c.id ? "on" : ""} disabled={busy} onClick={() => setChainId(c.id)}>
            {c.name}
          </button>
        ))}
      </div>
      {!settings.usdtIntroSeen && (
        <div className="card intro">
          <strong>How it works</strong>
          <ol className="steps3">
            <li>Send USDT from your exchange to your address on {chain.name} (shown below), with a few cents of {chain.gas} for the fee.</li>
            <li>Buy here: your USDT becomes wPRL on your Ethereum address in Keshi, in a few seconds.</li>
            <li>Then Bridge brings the wPRL home as PRL.</li>
          </ol>
          <button className="btn small" onClick={() => saveSettings({ usdtIntroSeen: true })}>
            Got it
          </button>
        </div>
      )}
      <dl className="rows">
        <Row k={`Your USDT on ${chain.name}`} v={src ? `${fmtUsdt(src.usdt)} USDT` : srcError ? "?" : "···"} />
        <Row k={`${chain.gas} for ${chain.name}'s fee`} v={src ? (src.gas === 0n ? "none" : `${core.formatUnits(src.gas, 18, 5)} ${chain.gas}`) : "···"} />
      </dl>
      {srcError && <p className="hint">{srcError}</p>}
      <p className="muted small">
        Send USDT to this address on {chain.name} from any exchange (plus a few cents of {chain.gas} for its fee), then buy.{" "}
        <button className="link inline" onClick={() => setShowAddr(!showAddr)}>
          {showAddr ? "Hide the address" : "Show the address"}
        </button>
      </p>
      {showAddr && src && <EthAddressCard address={src.address} title={`Your address on ${chain.name}`} chain={chain.name} />}
      <label className="field">
        <span>
          Amount of USDT to spend <em>{src ? `${fmtUsdt(src.usdt)} available` : ""}</em>
        </span>
        <div className="with-btn">
          <input inputMode="decimal" placeholder="0.00" value={amount} disabled={busy} onChange={(e) => { setAmount(e.target.value); setQuotes(null); }} />
          {src && src.usdt > 0n && (
            <button type="button" disabled={busy} onClick={() => { setAmount(core.formatUnits(src.usdt, dec, dec).replace(/,/g, "")); setQuotes(null); }}>
              Spend all
            </button>
          )}
        </div>
        {!quotes && roughPrl !== null && Number.isFinite(roughPrl) && roughPrl > 0 && (
          <small className="muted">
            About {roughPrl.toLocaleString("en-US", { maximumFractionDigits: roughPrl < 10 ? 2 : 0 })} PRL at today's price{ethLeg ? ", after the ETH part" : ""}. The quote gives the exact figure.
          </small>
        )}
      </label>
      {!quotes && suggestedMin !== null && typedUsd !== null && typedUsd > 0 && typedUsd < suggestedMin && (
        <p className="hint">
          Small amounts cost more: about {usd(fixedUsd!)} of fixed fees (paid to LI.FI, the bridges and the network, not to Keshi) on the way to PRL, around {fixedShare}% of this purchase. From about {suggestedMin} USDT they fall under 5%.
        </p>
      )}
      {ethUsdtNeeded !== null && ethUsdtNeeded > 0n && (
        <label className="check">
          <input type="checkbox" checked={withEth} disabled={busy} onChange={(e) => { setWithEth(e.target.checked); setQuotes(null); }} />
          {ethLegLarge && withEth && <span className="hint warn">That is more than a fifth of this purchase; untick it if you would rather get ETH another way.</span>}
          <span>
            Also buy about {fmtUsdt(ethUsdtNeeded)} USDT of ETH, to pay the bridge fee when you bring the wPRL back as PRL. This is a second, separate purchase: its own permission and transaction on {chain.name}, with its own network fee, sent only once the wPRL purchase is confirmed. If it fails, the wPRL purchase stays done.{" "}
            <em className="muted">Your Ethereum address has {hold ? fmtEth(hold.eth) : "···"} ETH; the bridge needs about {ethNeed ? core.formatEth(ethNeed, 4) : "···"}.</em>
          </span>
        </label>
      )}
      {ethUsdtNeeded === 0n && <p className="muted small">Your Ethereum address already holds enough ETH for the return to PRL.</p>}
      {!quotes && (
        <button className="btn primary" disabled={quoting || busy || !typed} onClick={getQuote}>
          {quoting ? "Asking LI.FI…" : "Get a quote"}
        </button>
      )}
      {quotes && (
        <>
          <dl className="rows">
            <Row k="You pay" v={`${fmtUsdt(quotes.wprl.fromAmount + (quotes.eth?.fromAmount ?? 0n))} USDT on ${chain.name}`} />
            <Row k="You receive about" v={`${formatPrl(wprlOut, 4)} wPRL (${usd(quotes.wprl.toAmountUsd)})`} />
            <Row k="At least" v={`${formatPrl(wprlMin, 4)} wPRL`} />
            {quotes.eth && <Row k="Plus ETH for fees" v={`${fmtEth(quotes.eth.toAmount)} ETH (${usd(quotes.eth.toAmountUsd)})`} />}
            <Row k="Route" v={`${quotes.wprl.toolName} via LI.FI, ${seconds(quotes.wprl.duration)}`} />
            {(() => {
              // Two separate lines: what Keshi keeps, and what the route (LI.FI and the bridges) keeps.
              const keshiUsd = quotes.wprl.keshiFeeUsd + (quotes.eth?.keshiFeeUsd ?? 0);
              const routeUsd = Math.max(0, quotes.wprl.includedFeesUsd + (quotes.eth?.includedFeesUsd ?? 0) - keshiUsd);
              return (
                <>
                  {keshiUsd > 0 && <Row k={`Keshi fee (${core.usdtBuyFee()?.label ?? "0.5%"})`} v={usd(keshiUsd)} />}
                  <Row k="Route fees, not Keshi" v={usd(routeUsd)} />
                </>
              );
            })()}
            {quotes.wprl.extraFeesUsd + (quotes.eth?.extraFeesUsd ?? 0) > 0 && <Row k="Other fees on top, not Keshi" v={usd(quotes.wprl.extraFeesUsd + (quotes.eth?.extraFeesUsd ?? 0))} />}
            <Row k={`${chain.name} fee`} v={`about ${usd(quotes.wprl.gasUsd + (quotes.eth?.gasUsd ?? 0))}, paid in ${chain.gas}`} />
            {hold && <Row k="Your wPRL after" v={<After from={`${formatPrl(hold.wprl, 4)} wPRL`} to={`${formatPrl(hold.wprl + wprlOut, 4)} wPRL`} about />} />}
            {hold && quotes.eth && <Row k="Your ETH after" v={<After from={`${fmtEth(hold.eth)} ETH`} to={`${fmtEth(hold.eth + quotes.eth.toAmount)} ETH`} about />} />}
            {src && <Row k={`Your USDT on ${chain.name} after`} v={<After from={`${fmtUsdt(src.usdt)} USDT`} to={`${fmtUsdt(src.usdt - typed!)} USDT`} />} />}
          </dl>
          {price && quotes.wprl.toAmountUsd > 0 && (
            <p className="muted small">
              That is {usd(quotes.wprl.toAmountUsd / prlToNumber(wprlOut))} per PRL. Exchanges are around {usd(price)} right now.
            </p>
          )}
          <p className="muted small">
            Keshi's {core.usdtBuyFee()?.label ?? "0.5%"} fee is inside the quote.{" "}
            {quotes.eth
              ? `Two purchases follow, one after the other: the wPRL, then the ETH once the first is confirmed. Each takes one transaction on ${chain.name}, two if LI.FI first needs permission for its exact amount, and each pays its own network fee. Keep Keshi open until both are sent.`
              : `The USDT leaves ${chain.name} in one transaction (two if LI.FI first needs permission for this exact amount); wPRL arrives on Ethereum on its own, and you can close Keshi meanwhile.`}
          </p>
          {step && <p className="muted small">{step}</p>}
          <div className="actions">
            <button className="btn primary" disabled={busy} onClick={buy}>
              {busy ? "Working…" : "Buy"}
            </button>
            <button className="btn" disabled={busy} onClick={() => setQuotes(null)}>
              Change
            </button>
          </div>
        </>
      )}
      {error && <p className="error">{error}</p>}
      {sent && (
        <div className="card start">
          <strong>Sent</strong>
          <p className="muted">Your USDT is on its way. The list below follows it until the wPRL lands on your Ethereum address; then bring it home as PRL with the bridge.</p>
          <button className="btn primary" onClick={() => open({ kind: "bridge" })}>
            Bridge wPRL to PRL
          </button>
        </div>
      )}
      {purchases.length > 0 && (
        <>
          <h3>Your USDT purchases</h3>
          <ul className="list plain">
            {purchases.map((p) => {
              const c = core.sourceChain(p.chain);
              const s = status[p.txHash];
              return (
                <li key={p.txHash}>
                  <span className="main">
                    <span>
                      {core.formatUnits(p.amount, c.usdt.decimals, 2)} USDT on {c.name} → {p.to === "wprl" ? `${formatPrl(p.expected, 4)} wPRL` : `${fmtEth(p.expected)} ETH`}
                    </span>
                    <small className={p.outcome === "failed" || p.outcome === "partial" ? "down" : ""}>{s ? core.describeStatus(s) : p.outcome ? OUTCOME[p.outcome] : p.done ? "Ended: check Details for the outcome." : Date.now() - p.at > 2 * 3600_000 ? "No longer followed here: check Details." : "Checking…"}</small>
                  </span>
                  <a className="link" href={(s?.explorer ?? c.explorerTx.replace("{hash}", p.txHash))} target="_blank" rel="noreferrer">
                    Details
                  </a>
                </li>
              );
            })}
          </ul>
        </>
      )}
      <details className="explain">
        <summary>How this works</summary>
        <p>No exchange account, and Keshi never holds the money. LI.FI is a service that finds the cheapest path between chains. Keshi asks it for a quote and shows it to you; if you accept, your wallet signs one transaction on {chain.name} that hands the USDT to LI.FI's contract. LI.FI's partners carry the value to Ethereum and swap it for wPRL on Uniswap, delivered to the very same address, which is yours on every Ethereum-compatible chain.</p>
        <p>What can go wrong: if a route fails mid-way, LI.FI usually refunds the USDT on {chain.name}, sometimes partly, sometimes only after a while; in rare cases it has to be claimed on LI.FI's site. Each purchase in the list keeps its outcome, and Details opens LI.FI's own page. Quotes move with the market; the "at least" figure is the floor you accept. Keshi's fee is taken inside the quote by LI.FI's contract and paid to Keshi; the rest goes to the bridges and to {chain.name}'s network.</p>
      </details>
    </>
  );
  if (embedded) return body;
  return (
    <div className="screen">
      <Header title="Buy with USDT" onBack={onClose} />
      {body}
    </div>
  );
}

/* ------------------------------------------------------------------ PRL */

const VALUE_PERIODS = HOME_PERIODS.filter((p) => p.id !== "24H");

/** The PRL screen: balance, its value over time, and addresses watched without their keys. */
function PrlAsset({ snap, secrets, net, price, open, onClose, settings, reload }: Ctx & { open: (s: Sheet) => void; onClose: () => void }) {
  const hidden = settings.hideBalance;
  const held = snap ? snap.balance + snap.immature : null;
  const [period, setPeriod] = useState<(typeof VALUE_PERIODS)[number]["id"]>("30D");
  const [points, setPoints] = useState<core.Point[] | null>(null);
  const [inUsd, setInUsd] = useState(true);
  useEffect(() => {
    if (!snap) return;
    let alive = true;
    setPoints(null);
    const p = VALUE_PERIODS.find((x) => x.id === period)!;
    const build = (prices: core.Point[] | null) => alive && setPoints(core.valueSeries(held!, snap.activity, prices, undefined, p.days));
    if (net.id !== "mainnet") {
      setInUsd(false);
      build(null);
      return;
    }
    priceSeries(p)
      .then((r) => { setInUsd(true); build(r.pts); })
      .catch(() => { setInUsd(false); build(null); });
    return () => {
      alive = false;
    };
  }, [period, snap?.updated, net.id]);
  const first = points?.[0]?.value, last = points?.[points.length - 1]?.value;
  const move = first !== undefined && last !== undefined ? last - first : null;
  const fmt = (v: number) => (inUsd ? usd(v) : `${v.toLocaleString("en-US", { maximumFractionDigits: 2 })} PRL`);
  return (
    <div className="screen">
      <Header title="PRL" onBack={onClose} />
      <div className="asset-hero">
        <Coin name="PRL" native />
        <p className="hero-amt">
          {held === null ? "···" : hidden ? "•••" : formatPrl(snap!.balance, 4)} <small>PRL</small>
        </p>
      </div>
      {snap && price && !hidden && <p className="muted">{usd(prlToNumber(snap.balance) * price)}</p>}
      {snap && snap.immature > 0n && !hidden && <p className="muted small">plus {formatPrl(snap.immature)} PRL mined, spendable after 100 blocks</p>}
      <div className="actions three">
        <button className="btn primary" onClick={() => open({ kind: "send" })}>
          Send
        </button>
        <button className="btn" onClick={() => open({ kind: "receive" })}>
          Receive
        </button>
        <button className="btn" onClick={() => open({ kind: "trade", side: "buy" })}>
          Buy
        </button>
      </div>
      <section className="pricecard">
        <div className="row-head">
          <h3>Your PRL over time</h3>
          {move !== null && !hidden && (
            <span className={`delta ${move >= 0 ? "up" : "dn"}`}>
              {move >= 0 ? "+" : "-"}
              {fmt(Math.abs(move))}
            </span>
          )}
        </div>
        {hidden ? (
          <div className="chart empty">Balances are hidden (Settings → Privacy).</div>
        ) : (
          <Chart points={points} format={fmt} label={inUsd ? "Value of your PRL in dollars" : "Your PRL balance"} />
        )}
        <div className="periods wide">
          {VALUE_PERIODS.map((p) => (
            <button key={p.id} className={period === p.id ? "on" : ""} onClick={() => setPeriod(p.id)}>
              {p.id}
            </button>
          ))}
        </div>
        <p className="muted small">
          {inUsd ? "What the PRL you held was worth at each moment, at that moment's price. " : "How many PRL this wallet held. "}
          Worked out from this wallet's own payments; only the coins Keshi knows about are counted.
        </p>
      </section>
      <Watched net={net} price={price} hidden={hidden} reloadKey={snap?.updated} snap={snap} secrets={secrets} />
    </div>
  );
}

interface WatchedAddress {
  name: string;
  address: string;
}

/** Addresses followed without their keys: a mining payout address, another wallet. Read only, nothing can be spent from here. */
function Watched({ net, price, hidden, reloadKey, snap, secrets }: { net: core.Network; price: number | null; hidden: boolean; reloadKey?: number; snap?: Ctx["snap"]; secrets: core.Secrets }) {
  const [list, setList] = useState<WatchedAddress[]>([]);
  // This wallet's own addresses (receive, change, mining, quantum-ready): already in the balance, so not worth watching.
  const [pqAddress, setPqAddress] = useState<string | null>(null);
  useEffect(() => {
    store.quantumAddress(secrets, net).then((p) => setPqAddress(p?.address ?? null)).catch(() => setPqAddress(null));
  }, [secrets, net.id]);
  const isOwn = (a: string) => {
    const x = a.toLowerCase();
    if (core.accountOf(secrets, net).derive(false, 0).address.toLowerCase() === x) return true;
    if (pqAddress?.toLowerCase() === x) return true;
    if (!snap) return false;
    return [...snap.addresses.map((d) => d.address), snap.receive.address, snap.changeAddr.address].some((o) => o.toLowerCase() === x);
  };
  const [balances, setBalances] = useState<Record<string, bigint | null>>({});
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const [error, setError] = useState("");
  const [copied, copy] = useCopy();
  useEffect(() => {
    local.get<WatchedAddress[]>("watched").then((w) => setList(w ?? []));
  }, []);
  useEffect(() => {
    if (!list.length) return;
    const idx = new core.Indexer(net);
    for (const w of list)
      idx
        .address(w.address, false)
        .then((i) => setBalances((b) => ({ ...b, [w.address]: i.balance + i.unconfirmed })))
        .catch(() => setBalances((b) => ({ ...b, [w.address]: b[w.address] ?? null })));
  }, [list, net.id, reloadKey]);
  const save = async (next: WatchedAddress[]) => {
    setList(next);
    await local.set("watched", next);
  };
  const add = () => {
    const a = address.trim();
    if (!core.isValidAddress(a, net)) return setError(`That is not a valid ${net.hrp}1… address`);
    if (list.some((w) => w.address === a)) return setError("You already watch this address");
    if (isOwn(a)) return setError("This is one of your own addresses: it is already in your balance.");
    setError("");
    save([...list, { name: name.trim() || `Watched ${list.length + 1}`, address: a }]);
    setName("");
    setAddress("");
    setAdding(false);
  };
  const total = list.reduce((s, w) => s + (balances[w.address] ?? 0n), 0n);
  return (
    <section>
      <div className="row-head">
        <h3>Watched addresses</h3>
        {list.length > 0 && !hidden && <span className="muted small">{formatPrl(total, 2)} PRL</span>}
      </div>
      <p className="muted small">Follow any Pearl address without its keys: a mining payout address, a cold wallet, a friend. Keshi only reads its balance; nothing can be spent from here, and these coins are not in your total.</p>
      {list.length > 0 && (
        <ul className="list watched">
          {list.map((w) => {
            const b = balances[w.address];
            return (
              <li key={w.address}>
                <div className="row">
                  <span className="main">
                    <span>{w.name}</span>
                    <small>{short(w.address, 10)}</small>
                  </span>
                  <span className="main end">
                    <span className="amt">{hidden ? "•••" : b === undefined ? "···" : b === null ? "?" : `${formatPrl(b, 4)} PRL`}</span>
                    <small>{hidden || !b || !price ? (b === null ? "could not be read" : "") : usd(prlToNumber(b) * price)}</small>
                  </span>
                </div>
                <div className="tools">
                  <button className="link" onClick={() => copy(w.address, w.address)} aria-label={`Copy ${w.name}`}>
                    {copied === w.address ? "Copied" : "Copy address"}
                  </button>
                  <button className="link" onClick={() => save(list.filter((x) => x.address !== w.address))}>
                    Remove
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {adding ? (
        <>
          <label className="field">
            <span>Name</span>
            <input value={name} placeholder="Mining payouts" onChange={(e) => setName(e.target.value)} />
          </label>
          <label className="field">
            <span>Address</span>
            <input value={address} spellCheck={false} placeholder={`${net.hrp}1…`} onChange={(e) => setAddress(e.target.value.replace(/\s/g, ""))} />
          </label>
          {error && <p className="error">{error}</p>}
          <div className="actions">
            <button className="btn primary" onClick={add}>
              Watch this address
            </button>
            <button className="btn" onClick={() => { setAdding(false); setError(""); }}>
              Cancel
            </button>
          </div>
        </>
      ) : (
        <button className="btn" onClick={() => setAdding(true)}>
          Watch an address
        </button>
      )}
    </section>
  );
}

/** Send ETH or wPRL from the wallet's Ethereum address to another one. No Keshi fee. */
function EthSend({ asset, secrets, price, onClose }: Ctx & { asset: EthAssetName; onClose: () => void }) {
  const own = useMemo(() => core.ethAccountOf(secrets).address, [secrets]);
  const [hold, setHold] = useState<store.EthHoldings | null>(null);
  const [ethUsd, setEthUsd] = useState<number | null>(null);
  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("");
  const [max, setMax] = useState(false);
  const [review, setReview] = useState<{ plan: core.EthSendPlan; contract: boolean; twin?: string; first: boolean } | null>(null);
  const [noFee, setNoFee] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [hash, setHash] = useState("");
  const [pasteHint, setPasteHint] = useState("");
  const toRef = useRef<HTMLTextAreaElement>(null);
  const [earlier, setEarlier] = useState<string | null>(null);
  const [earlierOk, setEarlierOk] = useState(false);
  useEffect(() => {
    store.ethHoldings(secrets).then(setHold).catch(() => setError("Could not reach Ethereum just now. Try again in a moment."));
    ethUsdNow().then(setEthUsd);
    store.unconfirmedEthSend().then(setEarlier).catch(() => {});
  }, [secrets]);
  const have = hold ? (asset === "ETH" ? hold.eth : hold.wprl) : null;
  const fmt = (v: bigint) => (asset === "ETH" ? core.formatEth(v, 6).replace(/(\.\d*?[1-9])0+$/, "$1").replace(/\.0+$/, ".0") : formatPrl(v, 4));
  const dollars = (v: bigint) => (asset === "ETH" ? (ethUsd ? (Number(v) / 1e18) * ethUsd : null) : price ? prlToNumber(v) * price : null);
  const feeUsd = (wei: bigint) => (ethUsd ? usd((Number(wei) / 1e18) * ethUsd) : "");
  const parse = (t: string) => (asset === "ETH" ? core.parseUnits(t, 18) : parsePrl(t));
  const typed = max ? null : parse(amount);

  const paste = async () => {
    setPasteHint("");
    try {
      const text = (await navigator.clipboard.readText()).trim();
      if (!text) throw new Error("empty");
      setError("");
      setTo(text.replace(/\s/g, ""));
    } catch {
      toRef.current?.focus();
      setPasteHint("Press Ctrl+V (or long-press) to paste the address here.");
    }
  };

  const prepare = async () => {
    setError("");
    setNoFee(false);
    const problem = core.ethRecipientProblem(to, own, await store.ethTokens().catch(() => []));
    if (problem) return setError(problem);
    if (!hold) return setError("Still reading your Ethereum address. Try again in a moment.");
    // A send whose answer was lost may still go through: never prepare another one without the user saying so.
    const waiting = await store.unconfirmedEthSend().catch(() => null);
    setEarlier(waiting);
    if (waiting && !earlierOk) return;
    const value = max ? "max" : parse(amount);
    if (value === null || value === 0n) return setError(asset === "ETH" ? "Enter an amount in ETH, for example 0.01" : "Enter an amount in wPRL, for example 12.5");
    setBusy(true);
    try {
      const rpc = new core.EthRpc();
      const plan = await core.planEthSend(rpc, own, to.trim(), value, { eth: hold.eth, token: hold.wprl }, asset === "wPRL" ? core.WPRL_CONTRACT : undefined);
      const [contract, history] = await Promise.all([rpc.isContract(to.trim()).catch(() => false), store.ethActivity(secrets).catch(() => [] as core.EthActivity[])]);
      const known = [...new Set(history.map((h) => h.counterparty?.toLowerCase()).filter((x): x is string => !!x))];
      const twin = core.lookalikeOf(to.trim().toLowerCase(), known);
      setReview({ plan, contract, twin, first: !known.includes(to.trim().toLowerCase()) });
    } catch (e) {
      if (errText(e) === "NO_ETH_FOR_FEE") setNoFee(true);
      else setError(errText(e));
    } finally {
      setBusy(false);
    }
  };

  const send = async () => {
    if (!review) return;
    setBusy(true);
    setError("");
    try {
      setHash(await store.sendEth(secrets, review.plan));
    } catch (e) {
      setError(errText(e));
      setBusy(false);
    }
  };

  if (hash)
    return (
      <div className="screen">
        <div className="done">
          <div className="pearl" aria-hidden="true" />
          <h2>Sent</h2>
          <p className="muted">
            {fmt(review!.plan.amount)} {asset} is on its way to {short(to.trim())}. Ethereum confirms it in a minute or two.
          </p>
        </div>
        <div className="stack">
          <a className="btn" href={`https://etherscan.io/tx/${hash}`} target="_blank" rel="noreferrer noopener">
            View on Etherscan
          </a>
          <button className="btn primary" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    );

  if (review) {
    const p = review.plan;
    const value = dollars(p.amount);
    return (
      <div className="screen">
        <Header title={`Review ${asset} send`} onBack={() => !busy && setReview(null)} />
        <p className="hero-amt">
          {fmt(p.amount)} <small>{asset}</small>
        </p>
        <dl className="rows">
          <Row k="To" v={<Addr value={to.trim()} className="mono-wrap addr-in" />} />
          <Row k="Network" v="Ethereum" />
          {value !== null && <Row k="Value" v={usd(value)} />}
          <Row k="Ethereum fee" v={`up to ${core.formatEth(p.fee, 6)} ETH${feeUsd(p.fee) ? ` (${feeUsd(p.fee)})` : ""}`} />
          <Row k="Keshi fee" v="None" />
          {asset === "ETH" && <Row k="Total leaving your address" v={`up to ${core.formatEth(p.amount + p.fee, 6)} ETH`} />}
          {hold && asset === "wPRL" && <Row k="Your wPRL after" v={<After from={`${formatPrl(hold.wprl, 4)} wPRL`} to={`${formatPrl(hold.wprl - p.amount < 0n ? 0n : hold.wprl - p.amount, 4)} wPRL`} />} />}
          {hold && (() => {
            const left = hold.eth - p.fee - (asset === "ETH" ? p.amount : 0n);
            return <Row k="Your ETH after" v={<After from={`${fmtEth(hold.eth)} ETH`} to={`at least ${fmtEth(left < 0n ? 0n : left)} ETH`} />} />;
          })()}
        </dl>
        {review.twin && (
          <p className="hint warn">
            This address looks like {short(review.twin, 6)}, which you have dealt with before, but it is a different address. Scammers forge look-alikes. Check every character before sending.
          </p>
        )}
        {!review.twin && review.first && <p className="hint">First send to this address from this wallet.</p>}
        {review.contract && (
          <p className="hint">This address is a smart contract, not a simple wallet. Exchanges and smart wallets work this way; make sure it accepts {asset} on Ethereum.</p>
        )}
        <p className="muted small">Ethereum transfers cannot be reversed. Only send to an Ethereum address (0x…): never to a Pearl address, and never to an exchange that does not list {asset}.</p>
        {error && <p className="error">{error}</p>}
        <div className="grow" />
        <button className="btn primary" disabled={busy} onClick={send}>
          {busy ? "Sending…" : `Send ${asset}`}
        </button>
      </div>
    );
  }

  return (
    <div className="screen">
      <Header title={`Send ${asset}`} onBack={onClose} />
      <p className="muted small">From your Ethereum address in Keshi, to another Ethereum address (0x…).</p>
      {earlier && (
        <p className="hint warn">
          Your last Ethereum send is still waiting to be confirmed ({short(earlier, 6)}).{" "}
          <a href={`https://etherscan.io/tx/${earlier}`} target="_blank" rel="noreferrer noopener">
            Check it on Etherscan
          </a>{" "}
          before sending again, or you may pay twice.
          {!earlierOk && (
            <>
              {" "}
              <button className="link" onClick={() => setEarlierOk(true)}>
                I checked: send a new one anyway
              </button>
            </>
          )}
        </p>
      )}
      <label className="field">
        <span>To</span>
        <div className="with-btn">
          <textarea ref={toRef} rows={2} placeholder="0x…" spellCheck={false} value={to} onChange={(e) => {
              setError("");
              setPasteHint("");
              setTo(e.target.value.replace(/\s/g, ""));
            }} />
          {!to && (
            <button type="button" onClick={paste} aria-label="Paste address">
              Paste
            </button>
          )}
        </div>
        {pasteHint && <small className="muted">{pasteHint}</small>}
      </label>
      <label className="field">
        <span>
          Amount <em>{have === null ? "reading…" : `${fmt(have)} ${asset} available`}</em>
        </span>
        <div className="with-btn">
          <input inputMode="decimal" placeholder="0.00" value={max ? "Everything" : amount} readOnly={max} onChange={(e) => setAmount(e.target.value)} />
          <button
            className={max ? "on" : ""}
            onClick={() => {
              setMax(!max);
              setAmount("");
            }}
          >
            Max
          </button>
        </div>
      </label>
      {typed && dollars(typed) !== null ? <p className="muted small">{usd(dollars(typed)!)}</p> : null}
      {max && asset === "ETH" && <p className="muted small">Everything except the Ethereum fee, which is taken from the same ETH.</p>}
      {noFee && hold && (
        <GetEth
          address={own}
          lead={
            asset === "ETH"
              ? `There is not enough ETH left for the Ethereum fee. Send a little less, or add some ETH: you have ${core.formatEth(hold.eth, 6)} ETH.`
              : `Sending wPRL is an Ethereum transaction: its fee is paid in ETH, and this address has ${core.formatEth(hold.eth, 6)} ETH. Add a little ETH first.`
          }
        />
      )}
      {error && <p className="error">{error}</p>}
      <div className="grow" />
      <button className="btn primary" disabled={busy || !to || (!max && !amount)} onClick={prepare}>
        {busy ? "Checking…" : "Review"}
      </button>
    </div>
  );
}

/* ---------------------------------------------- Sending tokens and inscriptions */

/** A Pearl address field with a Paste button, shared by the token and inscription sends. */
function PearlTo({ value, onChange, net }: { value: string; onChange: (v: string) => void; net: core.Network }) {
  const [hint, setHint] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);
  const paste = async () => {
    setHint("");
    try {
      const text = (await navigator.clipboard.readText()).trim();
      if (!text) throw new Error("empty");
      onChange(text.replace(/\s/g, ""));
    } catch {
      ref.current?.focus();
      setHint("Press Ctrl+V (or long-press) to paste the address here.");
    }
  };
  return (
    <label className="field">
      <span>To</span>
      <div className="with-btn">
        <textarea ref={ref} rows={2} placeholder={`${net.hrp}1…`} spellCheck={false} value={value} onChange={(e) => onChange(e.target.value.replace(/\s/g, ""))} />
        {!value && (
          <button type="button" onClick={paste} aria-label="Paste address">
            Paste
          </button>
        )}
      </div>
      {hint && <small className="muted">{hint}</small>}
    </label>
  );
}

const pearlAddressProblem = (to: string, net: core.Network): string | null => {
  const a = to.trim();
  if (!a) return `Enter the ${net.hrp}1… address to send to`;
  if (/^0x[0-9a-fA-F]{40}$/.test(a)) return "This is an Ethereum address. PRL-20 tokens and inscriptions live on Pearl: send them to a Pearl address.";
  if (!core.isValidAddress(a, net)) return `That is not a valid ${net.hrp}1… address`;
  return null;
};

/**
 * Send a PRL-20 token. On Pearl this takes two steps: Keshi writes a transfer
 * note for the amount on the address that holds the tokens, and once the
 * token index has accepted it, sends the coin carrying the note to the
 * recipient. The second step happens on its own while this screen is open,
 * and can be finished later from Tokens.
 */
/** The same recipient checks for every kind of transfer: a look-alike of an address used before, or a first transfer to this one. */
function RecipientRisk({ to, known }: { to: string; known: string[] }) {
  const twin = core.lookalikeOf(to, known);
  if (twin)
    return (
      <p className="hint warn">
        This address looks like {short(twin, 6)}, which you have used before, but it is a different address. Scammers forge look-alikes. Check every character before sending.
      </p>
    );
  if (!known.includes(to)) return <p className="hint">First transfer to this address from this wallet.</p>;
  return null;
}

function TokenSend({ token, have, secrets, net, snap, reload, onClose }: Ctx & { token: core.Token; have: bigint; onClose: () => void }) {
  const [to, setTo] = useState("");
  const [known, setKnown] = useState<string[]>([]);
  useEffect(() => {
    store.knownAddresses(snap).then(setKnown).catch(() => {});
  }, [snap]);
  const [amount, setAmount] = useState("");
  const [q, setQ] = useState<store.TransferQuote | null>(null);
  const [phase, setPhase] = useState<"edit" | "review" | "waiting" | "done">("edit");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [txid, setTxid] = useState("");

  // While the screen is open, hand the coin over as soon as the index has accepted the note.
  const ticking = useRef(false);
  useEffect(() => {
    if (phase !== "waiting") return;
    let alive = true;
    const tick = async () => {
      if (ticking.current) return;
      ticking.current = true;
      try {
        if (!(await store.transferReady(net))) return;
        const id = await store.deliverTransfer(secrets, net);
        if (!alive) return;
        setTxid(id);
        setPhase("done");
        reload();
      } catch (e) {
        if (alive) setError(errText(e));
      } finally {
        ticking.current = false;
      }
    };
    void tick();
    const id = setInterval(tick, 15_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [phase]);

  const review = async () => {
    setError("");
    const problem = pearlAddressProblem(to, net);
    if (problem) return setError(problem);
    if (!/^\d+$/.test(amount.trim()) || BigInt(amount.trim()) === 0n) return setError("Enter a whole number of tokens, for example 1000");
    const n = BigInt(amount.trim());
    if (n > have) return setError(`You hold ${have.toLocaleString("en-US")} ${token.name}`);
    if (!snap) return setError("Still loading your wallet. Try again in a moment.");
    setBusy(true);
    try {
      setQ(await store.quoteTokenTransfer(secrets, net, snap, token.ticker, token.name, n, to));
      setPhase("review");
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };

  const confirm = async () => {
    if (!q || !snap) return;
    setBusy(true);
    setError("");
    try {
      await store.startTokenTransfer(secrets, net, snap, q);
      setPhase("waiting");
      reload();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };

  if (phase === "done")
    return (
      <>
        <div className="done">
          <div className="pearl" aria-hidden="true" />
          <h2>Sent</h2>
          <p className="muted">
            {q ? `${q.amount.toLocaleString("en-US")} ${q.name}` : token.name} {q ? `is on its way to ${short(q.to)}` : "is on its way"}. The token index credits it once the payment confirms.
          </p>
        </div>
        <div className="stack">
          <a className="btn" href={net.explorerTx.replace("{txid}", txid)} target="_blank" rel="noreferrer noopener">
            View on the Pearl explorer
          </a>
          <button className="btn primary" onClick={onClose}>
            Done
          </button>
        </div>
      </>
    );

  if (phase === "waiting")
    return (
      <>
        <Header title={`Sending ${token.name}`} onBack={onClose} />
        <div className="card">
          <p>
            <b>Step 1 of 2 done.</b> The transfer note for {q?.amount.toLocaleString("en-US")} {token.name} is published.
          </p>
          <p className="muted small">
            Keshi now waits for the token index to accept it, usually one block (a few minutes), then sends the tokens to {q ? short(q.to) : "the recipient"} on its own. You can close this screen: Tokens shows the transfer until it is finished.
          </p>
        </div>
        <p className="muted small">Checking every 15 seconds…</p>
        {error && <p className="hint">{error}</p>}
        <div className="grow" />
        <button className="btn" onClick={onClose}>
          Close, finish later
        </button>
      </>
    );

  if (phase === "review" && q) {
    const fees = q.plan.fee + q.revealFee + q.deliverFee;
    return (
      <>
        <Header title="Review token send" onBack={() => !busy && setPhase("edit")} />
        <p className="hero-amt">
          {q.amount.toLocaleString("en-US")} <small>{q.name}</small>
        </p>
        <dl className="rows">
          <Row k="To" v={<Addr value={q.to} className="mono-wrap addr-in" />} />
          <Row k="Goes with it" v="About 0.0005 PRL, the small coin that carries the tokens" />
          <Row k="Network fees" v={`about ${formatPrl(fees, 8).replace(/0+$/, "").replace(/\.$/, "")} PRL in all`} />
          <Row k="Keshi fee" v="None" />
        </dl>
        <RecipientRisk to={q.to} known={known} />
        <div className="card">
          <p className="small">Sending a PRL-20 token takes two Pearl transactions:</p>
          <ol className="howto">
            <li>Keshi writes a transfer note for this amount on your address.</li>
            <li>Once the token index accepts it, usually one block later, Keshi sends the small coin carrying the note to the recipient. The tokens travel with it.</li>
          </ol>
        </div>
        <p className="muted small">Token sends cannot be reversed. Check the address before you confirm.</p>
        {error && <p className="error">{error}</p>}
        <div className="grow" />
        <button className="btn primary" disabled={busy} onClick={confirm}>
          {busy ? "Sending…" : `Send ${q.name}`}
        </button>
      </>
    );
  }

  return (
    <>
      <Header title={`Send ${token.name}`} onBack={onClose} />
      <PearlTo value={to} net={net} onChange={(v) => { setError(""); setTo(v); }} />
      <label className="field">
        <span>
          Amount <em>{have.toLocaleString("en-US")} {token.name} available</em>
        </span>
        <div className="with-btn">
          <input inputMode="numeric" placeholder="0" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^\d]/g, ""))} />
          <button onClick={() => setAmount(have.toString())}>Max</button>
        </div>
      </label>
      <p className="muted small">PRL-20 amounts are whole numbers. The recipient needs a Pearl address (prl1…); a wallet that understands PRL-20 tokens will show them.</p>
      {error && <p className="error">{error}</p>}
      <div className="grow" />
      <button className="btn primary" disabled={busy || !to || !amount} onClick={review}>
        {busy ? "Calculating…" : "Review"}
      </button>
    </>
  );
}

/** Send an inscription (picture, text, file): the coin that holds it goes to the recipient, as the first output. */
function InscriptionSend({ ins, pic, held, secrets, net, snap, reload, onClose }: Ctx & { ins: core.Inscription; pic?: string; held: core.Inscription[]; onClose: () => void }) {
  const [to, setTo] = useState("");
  const [known, setKnown] = useState<string[]>([]);
  useEffect(() => {
    store.knownAddresses(snap).then(setKnown).catch(() => {});
  }, [snap]);
  const [r, setR] = useState<{ plan: core.Plan; together: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [txid, setTxid] = useState("");
  const title = ins.number >= 0 ? `Inscription #${ins.number.toLocaleString("en-US")}` : "Inscription";

  const review = async () => {
    setError("");
    const problem = pearlAddressProblem(to, net);
    if (problem) return setError(problem);
    if (!snap) return setError("Still loading your wallet. Try again in a moment.");
    setBusy(true);
    try {
      setR(await store.quoteInscriptionSend(net, snap, ins, held, to));
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };
  const confirm = async () => {
    if (!r || !snap) return;
    setBusy(true);
    setError("");
    try {
      setTxid(await store.pay(secrets, net, snap, r.plan));
      reload();
    } catch (e) {
      setError(errText(e));
      setBusy(false);
    }
  };
  const tile = pic ? <img className="thumb big" src={pic} alt="" /> : <span className="thumb glyph big">{ins.image ? "🖼" : ins.contentType === "application/json" ? "{ }" : "Aa"}</span>;

  if (txid)
    return (
      <>
        <div className="done">
          <div className="pearl" aria-hidden="true" />
          <h2>Sent</h2>
          <p className="muted">{title} is on its way to {short(r!.plan.to)}. It belongs to them once the payment confirms.</p>
        </div>
        <div className="stack">
          <a className="btn" href={net.explorerTx.replace("{txid}", txid)} target="_blank" rel="noreferrer noopener">
            View on the Pearl explorer
          </a>
          <button className="btn primary" onClick={onClose}>
            Done
          </button>
        </div>
      </>
    );

  if (r)
    return (
      <>
        <Header title="Review inscription send" onBack={() => !busy && setR(null)} />
        <div className="ins-hero">
          {tile}
          <div>
            <b>{title}</b>
            <p className="muted small">{ins.preview || ins.contentType || "file"}</p>
          </div>
        </div>
        <dl className="rows">
          <Row k="To" v={<Addr value={r.plan.to} className="mono-wrap addr-in" />} />
          <Row k="Goes with it" v={`${formatPrl(r.plan.amount, 8).replace(/0+$/, "").replace(/\.$/, "")} PRL, the small coin that holds it`} />
          <Row k="Network fee" v={`${formatPrl(r.plan.fee, 8).replace(/0+$/, "").replace(/\.$/, "")} PRL`} />
          <Row k="Keshi fee" v="None" />
        </dl>
        <RecipientRisk to={r.plan.to} known={known} />
        {r.together > 1 && <p className="hint warn">This coin holds {r.together} inscriptions. They all go to the recipient together.</p>}
        <p className="muted small">Inscription sends cannot be reversed. Check the address before you confirm.</p>
        {error && <p className="error">{error}</p>}
        <div className="grow" />
        <button className="btn primary" disabled={busy} onClick={confirm}>
          {busy ? "Sending…" : "Send inscription"}
        </button>
      </>
    );

  return (
    <>
      <Header title={`Send ${title}`} onBack={onClose} />
      <div className="ins-hero">
        {tile}
        <div>
          <b>{title}</b>
          <p className="muted small">{ins.preview || ins.contentType || "file"}</p>
        </div>
      </div>
      <PearlTo value={to} net={net} onChange={(v) => { setError(""); setTo(v); }} />
      {error && <p className="error">{error}</p>}
      <div className="grow" />
      <button className="btn primary" disabled={busy || !to} onClick={review}>
        {busy ? "Calculating…" : "Review"}
      </button>
    </>
  );
}

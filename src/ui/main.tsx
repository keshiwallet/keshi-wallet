import "@fontsource/bodoni-moda/latin-500.css";
import "@fontsource/bodoni-moda/latin-500-italic.css";
import "@fontsource-variable/hanken-grotesk/wght.css";
import "./styles.css";
import { createRoot } from "react-dom/client";
import { App } from "./app";
import { TermsGate } from "./terms";

// The terms come once, before the wallet (1.0.6).
createRoot(document.getElementById("root")!).render(
  <TermsGate>
    <App />
  </TermsGate>,
);

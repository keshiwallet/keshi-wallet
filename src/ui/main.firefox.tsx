import "@fontsource/bodoni-moda/latin-500.css";
import "@fontsource/bodoni-moda/latin-500-italic.css";
import "@fontsource-variable/hanken-grotesk/wght.css";
import "./styles.css";
import "./consent.css";
import { guardNetwork } from "../ext/consent";
import { createRoot } from "react-dom/client";
import { App } from "./app";
import { ConsentGate } from "./consent";

// Firefox popup: the same wallet as Chrome, behind the data consent screen.
guardNetwork();
createRoot(document.getElementById("root")!).render(
  <ConsentGate>
    <App />
  </ConsentGate>,
);

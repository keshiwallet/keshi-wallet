import { defineConfig } from "vitest/config";

// Some tests do real key work (scrypt vaults, signing hundreds of inputs,
// drawing many phrases): on a small or busy machine they need more than
// vitest's 5-second default. The limit only guards against hangs.
export default defineConfig({ test: { testTimeout: 30_000 } });

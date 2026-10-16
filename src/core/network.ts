// Pearl chain parameters, checked against pearl-research-labs/pearl
// (node/chaincfg/params.go, wallet/waddrmgr/scoped_manager.go).
export interface Network {
  id: "mainnet" | "testnet";
  label: string;
  hrp: string;
  coinType: number;
  indexer: string; // Blockbook v2
  explorerTx: string;
}

export const MAINNET: Network = {
  id: "mainnet",
  label: "Pearl mainnet",
  hrp: "prl",
  coinType: 808276,
  indexer: "https://blockbook.pearlresearch.ai",
  explorerTx: "https://explorer.pearlresearch.ai/tx/{txid}?network=mainnet",
};

export const TESTNET: Network = {
  id: "testnet",
  label: "Pearl testnet",
  hrp: "tprl",
  coinType: 1,
  indexer: "https://blockbook.testnet.pearlresearch.ai",
  explorerTx: "https://blockbook.testnet.pearlresearch.ai/tx/{txid}",
};

export const networkById = (id: string): Network => (id === "testnet" ? TESTNET : MAINNET);

export const DUST = 546n;
export const COINBASE_MATURITY = 100;
export const MIN_FEE_RATE = 1; // grains per vbyte (node relay minimum)

export function btcNet(net: Network) {
  return { bech32: net.hrp, pubKeyHash: 0x00, scriptHash: 0x05, wif: 0x80 };
}

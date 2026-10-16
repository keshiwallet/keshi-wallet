import { BRIDGE_CONTROLLER, isEthAddress, WPRL_CONTRACT } from "./bridge";
import { UNI_ROUTER, USDT, WETH } from "./uniswap";

// Checks on an Ethereum address the user is about to send to. Each answer is
// a plain sentence; null means the address is fine to send to.

const CONTRACTS: Record<string, string> = {
  [WPRL_CONTRACT.toLowerCase()]: "the wPRL token contract",
  [WETH.toLowerCase()]: "the WETH token contract",
  [USDT.toLowerCase()]: "the USDT token contract",
  [UNI_ROUTER.toLowerCase()]: "Uniswap's router",
  [BRIDGE_CONTROLLER.toLowerCase()]: "PearlBridge's contract (use Bridge to send wPRL back to Pearl)",
};

/** `tokens`: other token contracts the user added, which are not wallets either. */
export function ethRecipientProblem(to: string, own: string, tokens: { address: string; symbol: string }[] = []): string | null {
  const a = to.trim();
  if (!a) return "Enter the Ethereum address to send to";
  if (/^t?prl1/i.test(a)) return "This is a Pearl address. Send PRL with Send on the home screen; to move wPRL back to Pearl, use the bridge.";
  if (!/^0x[0-9a-fA-F]{40}$/.test(a)) return "That is not an Ethereum address: it starts with 0x and has 40 more characters.";
  if (!isEthAddress(a)) return "This address has a typo: its capital letters do not match its checksum. Copy it again from where it came from.";
  if (/^0x0{40}$/i.test(a)) return "This is the zero address: anything sent there is lost forever.";
  if (a.toLowerCase() === own.toLowerCase()) return "This is your own Ethereum address in Keshi.";
  const c = CONTRACTS[a.toLowerCase()] ?? (tokens.find((t) => t.address.toLowerCase() === a.toLowerCase()) ? `the ${tokens.find((t) => t.address.toLowerCase() === a.toLowerCase())!.symbol} token contract` : undefined);
  if (c) return `This is ${c}, not a wallet. Anything sent there is lost.`;
  return null;
}

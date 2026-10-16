import { shake256 } from "@noble/hashes/sha3.js";

// XMSS-SHAKE256 with a tree of height 5: the hash-based, post-quantum
// signature Pearl accepts through OP_CHECKXMSSSIG. This is a line-for-line
// port of the library the Pearl node uses (xmss/ in pearl-research-labs/pearl,
// itself the XMSS reference code), checked byte for byte against it.
//
// A key signs at most 32 times, and every signature must use a different
// number (`uid`). Signing twice with the same number lets anyone forge.

const N = 32; // hash length
const PAD = 32; // domain-separation prefix length
const W = 16;
const LEN1 = 64;
const LEN2 = 3;
const LEN = LEN1 + LEN2; // 67 chains
const HEIGHT = 5;

export const XMSS_PK_LEN = 64;
export const XMSS_SK_LEN = 128;
export const XMSS_SIG_LEN = 4 + N + LEN * N + HEIGHT * N; // 2340
/** The last number is refused: the reference code wipes the key before using it. */
export const XMSS_MAX_UID = 30;

const ADDR_OTS = 0, ADDR_LTREE = 1, ADDR_TREE = 2;
const PAD_F = 0, PAD_H = 1, PAD_HASH = 2, PAD_PRF = 3, PAD_PRF_KEYGEN = 4;

type Addr = Uint32Array; // 8 words

const toBytes = (out: Uint8Array, at: number, len: number, value: number): void => {
  // Big-endian. Values here always fit in 32 bits.
  for (let i = len - 1; i >= 0; i--) {
    out[at + i] = value & 0xff;
    value = Math.floor(value / 256);
  }
};
const addrBytes = (addr: Addr): Uint8Array => {
  const b = new Uint8Array(32);
  for (let i = 0; i < 8; i++) toBytes(b, i * 4, 4, addr[i]!);
  return b;
};
const hash = (input: Uint8Array): Uint8Array => shake256(input, { dkLen: N });

function prf(input32: Uint8Array, key: Uint8Array): Uint8Array {
  const buf = new Uint8Array(PAD + N + 32);
  toBytes(buf, 0, PAD, PAD_PRF);
  buf.set(key.subarray(0, N), PAD);
  buf.set(input32, PAD + N);
  return hash(buf);
}
function prfKeygen(input: Uint8Array, key: Uint8Array): Uint8Array {
  const buf = new Uint8Array(PAD + 2 * N + 32);
  toBytes(buf, 0, PAD, PAD_PRF_KEYGEN);
  buf.set(key.subarray(0, N), PAD);
  buf.set(input, PAD + N);
  return hash(buf);
}
function hashMessage(R: Uint8Array, root: Uint8Array, idx: number, msg: Uint8Array): Uint8Array {
  const buf = new Uint8Array(PAD + 3 * N + msg.length);
  toBytes(buf, 0, PAD, PAD_HASH);
  buf.set(R, PAD);
  buf.set(root, PAD + N);
  toBytes(buf, PAD + 2 * N, N, idx);
  buf.set(msg, PAD + 3 * N);
  return hash(buf);
}
/** Hash of two nodes. Leaves the key-and-mask word of `addr` at 2, as the reference does. */
function thashH(input64: Uint8Array, pubSeed: Uint8Array, addr: Addr): Uint8Array {
  const buf = new Uint8Array(PAD + 3 * N);
  toBytes(buf, 0, PAD, PAD_H);
  addr[7] = 0;
  buf.set(prf(addrBytes(addr), pubSeed), PAD);
  addr[7] = 1;
  const m0 = prf(addrBytes(addr), pubSeed);
  addr[7] = 2;
  const m1 = prf(addrBytes(addr), pubSeed);
  for (let i = 0; i < N; i++) {
    buf[PAD + N + i] = input64[i]! ^ m0[i]!;
    buf[PAD + 2 * N + i] = input64[N + i]! ^ m1[i]!;
  }
  return hash(buf);
}
function thashF(input32: Uint8Array, pubSeed: Uint8Array, addr: Addr): Uint8Array {
  const buf = new Uint8Array(PAD + 2 * N);
  toBytes(buf, 0, PAD, PAD_F);
  addr[7] = 0;
  buf.set(prf(addrBytes(addr), pubSeed), PAD);
  addr[7] = 1;
  const mask = prf(addrBytes(addr), pubSeed);
  for (let i = 0; i < N; i++) buf[PAD + N + i] = input32[i]! ^ mask[i]!;
  return hash(buf);
}

/* ------------------------------------------------------------- WOTS+ */

function expandSeed(seed: Uint8Array, pubSeed: Uint8Array, addr: Addr): Uint8Array[] {
  addr[6] = 0; // hash
  addr[7] = 0; // key and mask
  const out: Uint8Array[] = [];
  const buf = new Uint8Array(N + 32);
  buf.set(pubSeed.subarray(0, N), 0);
  for (let i = 0; i < LEN; i++) {
    addr[5] = i; // chain
    buf.set(addrBytes(addr), N);
    out.push(prfKeygen(buf, seed));
  }
  return out;
}
function genChain(input: Uint8Array, start: number, steps: number, pubSeed: Uint8Array, addr: Addr): Uint8Array {
  let out = input;
  for (let i = start; i < start + steps && i < W; i++) {
    addr[6] = i;
    out = thashF(out, pubSeed, addr);
  }
  return out;
}
function chainLengths(msg: Uint8Array): number[] {
  const lengths: number[] = [];
  for (let i = 0; i < N; i++) lengths.push(msg[i]! >> 4, msg[i]! & 15);
  let csum = 0;
  for (const l of lengths) csum += W - 1 - l;
  csum <<= 4; // 12 significant bits, left-aligned in two bytes
  const b0 = (csum >> 8) & 0xff, b1 = csum & 0xff;
  lengths.push(b0 >> 4, b0 & 15, b1 >> 4);
  return lengths;
}
function wotsPkGen(seed: Uint8Array, pubSeed: Uint8Array, addr: Addr): Uint8Array[] {
  const pk = expandSeed(seed, pubSeed, addr);
  for (let i = 0; i < LEN; i++) {
    addr[5] = i;
    pk[i] = genChain(pk[i]!, 0, W - 1, pubSeed, addr);
  }
  return pk;
}
function wotsSign(msg: Uint8Array, seed: Uint8Array, pubSeed: Uint8Array, addr: Addr): Uint8Array[] {
  const lengths = chainLengths(msg);
  const sig = expandSeed(seed, pubSeed, addr);
  for (let i = 0; i < LEN; i++) {
    addr[5] = i;
    sig[i] = genChain(sig[i]!, 0, lengths[i]!, pubSeed, addr);
  }
  return sig;
}
function wotsPkFromSig(sig: Uint8Array[], msg: Uint8Array, pubSeed: Uint8Array, addr: Addr): Uint8Array[] {
  const lengths = chainLengths(msg);
  const pk: Uint8Array[] = [];
  for (let i = 0; i < LEN; i++) {
    addr[5] = i;
    pk.push(genChain(sig[i]!, lengths[i]!, W - 1 - lengths[i]!, pubSeed, addr));
  }
  return pk;
}

/* -------------------------------------------------------------- tree */

const pair = (a: Uint8Array, b: Uint8Array): Uint8Array => {
  const out = new Uint8Array(2 * N);
  out.set(a, 0);
  out.set(b, N);
  return out;
};

function lTree(wotsPk: Uint8Array[], pubSeed: Uint8Array, addr: Addr): Uint8Array {
  const nodes = wotsPk.slice();
  let l = LEN, height = 0;
  addr[5] = height;
  while (l > 1) {
    const parents = l >> 1;
    for (let i = 0; i < parents; i++) {
      addr[6] = i;
      nodes[i] = thashH(pair(nodes[2 * i]!, nodes[2 * i + 1]!), pubSeed, addr);
    }
    if (l & 1) {
      nodes[l >> 1] = nodes[l - 1]!;
      l = (l >> 1) + 1;
    } else l >>= 1;
    height++;
    addr[5] = height;
  }
  return nodes[0]!;
}

function genLeaf(skSeed: Uint8Array, pubSeed: Uint8Array, ltreeAddr: Addr, otsAddr: Addr): Uint8Array {
  return lTree(wotsPkGen(skSeed, pubSeed, otsAddr), pubSeed, ltreeAddr);
}

/** Root of the tree and the authentication path of leaf `leafIdx`. */
function treehash(skSeed: Uint8Array, pubSeed: Uint8Array, leafIdx: number): { root: Uint8Array; auth: Uint8Array[] } {
  const ots = new Uint32Array(8), ltree = new Uint32Array(8), node = new Uint32Array(8);
  ots[3] = ADDR_OTS;
  ltree[3] = ADDR_LTREE;
  node[3] = ADDR_TREE;
  const stack: Uint8Array[] = [];
  const heights: number[] = [];
  const auth: Uint8Array[] = new Array(HEIGHT);
  for (let idx = 0; idx < 1 << HEIGHT; idx++) {
    ltree[4] = idx;
    ots[4] = idx;
    stack.push(genLeaf(skSeed, pubSeed, ltree, ots));
    heights.push(0);
    if ((leafIdx ^ 1) === idx) auth[0] = stack[stack.length - 1]!;
    while (stack.length >= 2 && heights[heights.length - 1] === heights[heights.length - 2]) {
      const h = heights[heights.length - 1]!;
      const treeIdx = idx >> (h + 1);
      node[5] = h;
      node[6] = treeIdx;
      const right = stack.pop()!, left = stack.pop()!;
      heights.pop();
      stack.push(thashH(pair(left, right), pubSeed, node));
      heights[heights.length - 1] = h + 1;
      if (((leafIdx >> (h + 1)) ^ 1) === treeIdx) auth[h + 1] = stack[stack.length - 1]!;
    }
  }
  return { root: stack[0]!, auth: auth.slice(0, HEIGHT) };
}

function computeRoot(leaf: Uint8Array, leafIdx: number, auth: Uint8Array[], pubSeed: Uint8Array, addr: Addr): Uint8Array {
  let buffer = leafIdx & 1 ? pair(auth[0]!, leaf) : pair(leaf, auth[0]!);
  for (let i = 0; i < HEIGHT - 1; i++) {
    addr[5] = i;
    leafIdx >>= 1;
    addr[6] = leafIdx;
    const h = thashH(buffer, pubSeed, addr);
    buffer = leafIdx & 1 ? pair(auth[i + 1]!, h) : pair(h, auth[i + 1]!);
  }
  addr[5] = HEIGHT - 1;
  leafIdx >>= 1;
  addr[6] = leafIdx;
  return thashH(buffer, pubSeed, addr);
}

/* --------------------------------------------------------------- API */

/** Key pair from a 64-byte private seed and a 32-byte public seed. Slow: it builds all 32 one-time keys. */
export function xmssKeygen(privateSeed: Uint8Array, publicSeed: Uint8Array): { pk: Uint8Array; sk: Uint8Array } {
  if (privateSeed.length !== 2 * N || publicSeed.length !== N) throw new Error("Bad XMSS seed length");
  const { root } = treehash(privateSeed.subarray(0, N), publicSeed, 0);
  const pk = new Uint8Array(XMSS_PK_LEN);
  pk.set(root, 0);
  pk.set(publicSeed, N);
  const sk = new Uint8Array(XMSS_SK_LEN);
  sk.set(privateSeed, 0);
  sk.set(root, 2 * N);
  sk.set(publicSeed, 3 * N);
  return { pk, sk };
}

/** Sign a 32-byte message with one-time key number `uid`. Never reuse a `uid` with the same key. */
export function xmssSign(uid: number, sk: Uint8Array, msg: Uint8Array): Uint8Array {
  if (!Number.isInteger(uid) || uid < 0 || uid > XMSS_MAX_UID) throw new Error("This post-quantum key has no signatures left");
  if (sk.length !== XMSS_SK_LEN || msg.length !== 32) throw new Error("Bad XMSS input length");
  const skSeed = sk.subarray(0, N), skPrf = sk.subarray(N, 2 * N), root = sk.subarray(2 * N, 3 * N), pubSeed = sk.subarray(3 * N, 4 * N);
  const idx32 = new Uint8Array(32);
  toBytes(idx32, 0, 32, uid);
  const R = prf(idx32, skPrf);
  const mhash = hashMessage(R, root, uid, msg);
  const ots = new Uint32Array(8);
  ots[3] = ADDR_OTS;
  ots[4] = uid;
  const wots = wotsSign(mhash, skSeed, pubSeed, ots);
  const { auth } = treehash(skSeed, pubSeed, uid);
  const sig = new Uint8Array(XMSS_SIG_LEN);
  toBytes(sig, 0, 4, uid);
  sig.set(R, 4);
  wots.forEach((w, i) => sig.set(w, 4 + N + i * N));
  auth.forEach((a, i) => sig.set(a, 4 + N + LEN * N + i * N));
  return sig;
}

export function xmssVerify(pk: Uint8Array, msg: Uint8Array, sig: Uint8Array): boolean {
  if (pk.length !== XMSS_PK_LEN || msg.length !== 32 || sig.length !== XMSS_SIG_LEN) return false;
  const root = pk.subarray(0, N), pubSeed = pk.subarray(N);
  const idx = ((sig[0]! << 24) | (sig[1]! << 16) | (sig[2]! << 8) | sig[3]!) >>> 0;
  const leafIdx = idx & ((1 << HEIGHT) - 1);
  const R = sig.subarray(4, 4 + N);
  const mhash = hashMessage(R, root, idx, msg);
  const ots = new Uint32Array(8), ltree = new Uint32Array(8), node = new Uint32Array(8);
  ots[3] = ADDR_OTS;
  ltree[3] = ADDR_LTREE;
  node[3] = ADDR_TREE;
  // With a single tree layer the tree address is the index above the leaf bits.
  const tree = Math.floor(idx / (1 << HEIGHT));
  ots[2] = ltree[2] = node[2] = tree;
  ots[4] = leafIdx;
  const wotsSig: Uint8Array[] = [];
  for (let i = 0; i < LEN; i++) wotsSig.push(sig.subarray(4 + N + i * N, 4 + N + (i + 1) * N));
  const wotsPk = wotsPkFromSig(wotsSig, mhash, pubSeed, ots);
  ltree[4] = leafIdx;
  const leaf = lTree(wotsPk, pubSeed, ltree);
  const auth: Uint8Array[] = [];
  for (let i = 0; i < HEIGHT; i++) auth.push(sig.subarray(4 + N + LEN * N + i * N, 4 + N + LEN * N + (i + 1) * N));
  const got = computeRoot(leaf, leafIdx, auth, pubSeed, node);
  let diff = 0;
  for (let i = 0; i < N; i++) diff |= got[i]! ^ root[i]!;
  return diff === 0;
}

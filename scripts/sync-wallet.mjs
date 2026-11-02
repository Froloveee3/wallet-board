// Pulls the wallet's transactions and balances from Solana and rewrites docs/data/wallet.enc
// only when something changed. Needs BOARD_PASSWORD; everything else comes from config.enc.
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
await import(pathToFileURL(path.join(root, 'docs', 'lib.js')).href);
const { decryptJSON, encryptJSON, signaturesSince, fetchTx, parseTx, balances, watchedAddresses } = globalThis.WalletLib;

const password = process.env.BOARD_PASSWORD;
if (!password) { console.error('BOARD_PASSWORD is not set'); process.exit(1); }
const RPC = process.env.SOLANA_RPC || ['https://api.mainnet-beta.solana.com', 'https://solana-rpc.publicnode.com'];
const dataDir = path.join(root, 'docs', 'data');
const readBox = async f => JSON.parse(await readFile(path.join(dataDir, f), 'utf8'));

const cfg = await decryptJSON(await readBox('config.enc'), password);
let prev = { txs: [], balances: null };
try { prev = await decryptJSON(await readBox('wallet.enc'), password); } catch { console.log('no previous wallet.enc, full sync'); }

const known = new Set(prev.txs.map(t => t.sig));
const addresses = watchedAddresses(cfg);
const fresh = new Map();
for (const a of addresses) {
  const limit = known.size ? 50 : 1000;
  for (const s of await signaturesSince(RPC, a, known, limit)) fresh.set(s.signature, s);
}
const added = [];
for (const sig of fresh.keys()) {
  const tx = await fetchTx(RPC, sig);
  if (!tx) continue;               // not yet available at this commitment, next run picks it up
  added.push(parseTx(tx, cfg));
}
const txs = [...prev.txs, ...added].sort((a, b) => a.time - b.time || a.slot - b.slot);
const bal = await balances(RPC, cfg);

const same = added.length === 0 && prev.balances &&
  Math.abs(prev.balances.win - bal.win) < 1e-9 && Math.abs(prev.balances.usdc - bal.usdc) < 1e-9 &&
  Math.abs(prev.balances.sol - bal.sol) < 1e-9 &&
  JSON.stringify(prev.balances.escrow || []) === JSON.stringify(bal.escrow || []);
if (same) { console.log('no changes'); process.exit(0); }

const next = { txs, balances: bal, syncedAt: Math.floor(Date.now() / 1000) };
await writeFile(path.join(dataDir, 'wallet.enc'), JSON.stringify(await encryptJSON(next, password)) + '\n');
console.log(`wallet.enc updated: ${added.length} new tx, ${txs.length} total`);

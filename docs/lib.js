// Shared by the page (classic <script>) and the sync script (Node, via import()).
// Sets globalThis.WalletLib.
(function (root) {
  'use strict';
  const enc = new TextEncoder(), dec = new TextDecoder();
  const subtle = root.crypto.subtle;

  const b64 = {
    to(buf) {
      const bytes = new Uint8Array(buf);
      if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64');
      let s = ''; for (const b of bytes) s += String.fromCharCode(b); return btoa(s);
    },
    from(str) {
      if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(str, 'base64'));
      const s = atob(str), out = new Uint8Array(s.length);
      for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i); return out;
    }
  };

  const ITER = 310000;
  async function deriveKey(password, salt, iter) {
    const base = await subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
    return subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iter },
      base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  }
  async function encryptJSON(obj, password) {
    const salt = root.crypto.getRandomValues(new Uint8Array(16));
    const iv = root.crypto.getRandomValues(new Uint8Array(12));
    const key = await deriveKey(password, salt, ITER);
    const ct = await subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(obj)));
    return { v: 1, kdf: 'PBKDF2-SHA256', iter: ITER, salt: b64.to(salt), iv: b64.to(iv), ct: b64.to(ct) };
  }
  async function decryptJSON(box, password) {
    const key = await deriveKey(password, b64.from(box.salt), box.iter);
    const pt = await subtle.decrypt({ name: 'AES-GCM', iv: b64.from(box.iv) }, key, b64.from(box.ct));
    return JSON.parse(dec.decode(pt));
  }

  // --- Solana RPC ---
  // `urls` is one endpoint or a list; each retry moves to the next endpoint in the list.
  async function rpc(urls, method, params, tries = 6) {
    const list = [].concat(urls);
    let wait = 800;
    for (let i = 0; ; i++) {
      try {
        const r = await fetch(list[i % list.length], { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
        if (r.status === 429 || r.status >= 500) throw new Error('HTTP ' + r.status);
        const j = await r.json();
        if (j.error) throw new Error(method + ': ' + j.error.message);
        return j.result;
      } catch (e) {
        if (i >= tries - 1) throw e;
        await new Promise(res => setTimeout(res, wait)); wait *= 2;
      }
    }
  }

  // Owner-level balance deltas for one parsed transaction.
  function parseTx(tx, cfg) {
    const m = tx.meta, W = cfg.wallet;
    const bal = list => {
      const o = {};
      for (const b of list || []) if (b.owner === W) o[b.mint] = (o[b.mint] || 0n) + BigInt(b.uiTokenAmount.amount);
      return o;
    };
    const pre = bal(m.preTokenBalances), post = bal(m.postTokenBalances);
    const d = mint => Number((post[mint] || 0n) - (pre[mint] || 0n));
    const keys = tx.transaction.message.accountKeys.map(k => typeof k === 'string' ? k : k.pubkey);
    const i = keys.indexOf(W);
    const feePayer = keys[0] === W;
    let sol = i >= 0 ? (m.postBalances[i] - m.preBalances[i]) : 0;
    if (feePayer) sol += m.fee;               // SOL moved by the trade itself, fee shown apart
    const out = {
      sig: tx.transaction.signatures[0], time: tx.blockTime, slot: tx.slot, ok: !m.err,
      win: d(cfg.mintWin) / 10 ** cfg.decWin, usdc: d(cfg.mintUsdc) / 1e6, sol: sol / 1e9,
      fee: feePayer ? m.fee / 1e9 : 0
    };
    out.type = classify(out);
    if (out.win && out.usdc && Math.sign(out.win) !== Math.sign(out.usdc)) out.price = Math.abs(out.usdc / out.win);
    return out;
  }
  function classify(t) {
    const e = 1e-12, w = t.win, u = t.usdc, s = t.sol;
    if (!t.ok) return 'FAILED';
    if (w > e && u < -e) return 'BUY';
    if (w < -e && u > e) return 'SELL';
    if (w > e && u > e) return 'CLAIM';
    if (w > e && s < -0.01) return 'BUY_SOL';     // below 0.01 SOL is account rent, not a trade
    if (w < -e && s > 0.01) return 'SELL_SOL';
    if (w > e) return 'WIN_IN';
    if (w < -e) return 'WIN_OUT';
    if (u > e && s < -1e-4) return 'SOL_TO_USDC';
    if (u < -e && s > 1e-4) return 'USDC_TO_SOL';
    if (u > e) return 'USDC_IN';
    if (u < -e) return 'USDC_OUT';
    if (s > 1e-6) return 'SOL_IN';
    if (s < -1e-6) return 'SOL_OUT';
    return 'OTHER';
  }

  async function signaturesSince(url, address, knownSet, limit) {
    const res = await rpc(url, 'getSignaturesForAddress', [address, { limit }]);
    return res.filter(s => !knownSet.has(s.signature));
  }
  async function fetchTx(url, sig) {
    return rpc(url, 'getTransaction', [sig, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 1, commitment: 'confirmed' }]);
  }
  // getMultipleAccounts works on public nodes that refuse indexed calls like getTokenAccountsByOwner.
  // Escrows are vaults of open limit orders (e.g. Jupiter): money that left the wallet but is still ours.
  async function balances(url, cfg) {
    const escrows = cfg.escrows || [];
    const escrowAccs = escrows.flatMap(e => [e.usdcAccount, e.winAccount]);
    const accs = [...cfg.tokenAccounts, cfg.wallet, ...escrowAccs];
    const r = await rpc(url, 'getMultipleAccounts', [accs, { encoding: 'jsonParsed', commitment: 'confirmed' }]);
    const out = { win: 0, usdc: 0, sol: 0, escrow: escrows.map(e => ({ id: e.id, usdc: 0, win: 0 })) };
    r.value.forEach((a, i) => {
      if (!a) return;
      if (accs[i] === cfg.wallet) { out.sol = a.lamports / 1e9; return; }
      const info = a.data && a.data.parsed && a.data.parsed.info;
      if (!info) return;
      const amt = Number(info.tokenAmount.uiAmountString);
      const k = info.mint === cfg.mintWin ? 'win' : info.mint === cfg.mintUsdc ? 'usdc' : null;
      if (!k) return;
      if (info.owner === cfg.wallet) { out[k] += amt; return; }
      const ei = escrows.findIndex(e => e.owner === info.owner && (e.usdcAccount === accs[i] || e.winAccount === accs[i]));
      if (ei >= 0) out.escrow[ei][k] += amt;
    });
    return out;
  }
  const watchedAddresses = cfg => [cfg.wallet, ...(cfg.tokenAccounts || []), ...(cfg.escrows || []).flatMap(e => [e.usdcAccount, e.winAccount])];

  root.WalletLib = { encryptJSON, decryptJSON, rpc, parseTx, classify, signaturesSince, fetchTx, balances, watchedAddresses };
})(globalThis);

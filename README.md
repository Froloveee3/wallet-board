# wallet-board

Private dashboard, served by GitHub Pages from `docs/`.

- `docs/index.html` — the page. Data in `docs/data/*.enc` is AES-GCM encrypted; the page decrypts it in the browser with the password.
- `docs/lib.js` — shared code: encryption, Solana RPC, transaction parsing.
- `scripts/sync-wallet.mjs` — run by the `board` workflow every 30 minutes; appends new wallet transactions to `docs/data/wallet.enc`.
- Secret `BOARD_PASSWORD` must match the page password.

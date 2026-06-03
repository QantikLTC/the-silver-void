# ✦ The SiŁver Void

> *"Lost coins only make everybody else's coins worth slightly more. Think of it as a donation to everyone."*
> — Satoshi Nakamoto

**The Silver Void** is a deflationary burn ritual built on [LiteForge Testnet](https://testnet.litvm.com) (LitVM, Chain ID 4441). Sacrifice zkLTC forever, earn permanent on-chain ranks, and unlock exclusive NFT rewards — engraved in the history of Litecoin.

🔗 **Live Demo** → [the-silver-void.vercel.app](https://the-silver-void.vercel.app)

---

## ⬡ What is it?

A single-page Web3 DApp where users burn zkLTC tokens into the dead address (`0x000...dEaD`) to:

- **Earn on-chain ranks** — from *Simple Holder* to *Silver Maximalist*
- **Unlock NFT rewards** — unique collectible badges per rank, claimable on-chain with 2.5% resale royalties
- **Contribute to deflation** — every burn is permanent, irreversible, forever

No staking. No yield. Pure sacrifice. For the Litecoin ecosystem.

---

## 🏆 Ranks of the Void

| Rank | Title | Requirement |
|------|-------|-------------|
| 1 · Initiate | Simple Holder | ≥ 0.5 zkLTC burned |
| 2 · Novice | Apprentice Litecoiner | ≥ 5 zkLTC burned |
| 3 · Adept | Devoted Litecoiner | ≥ 20 zkLTC burned |
| 4 · Elite | Silver Maximalist | ≥ 100 zkLTC burned |

Each rank unlocks a unique NFT pool with Common, Rare and Epic variants.

---

## 🎴 NFT Collection

| Rank | Common | Rare | Epic |
|------|--------|------|------|
| Simple Holder | The Litecoin Revelation | My First Coin | The Voyage Begins |
| Apprentice Litecoiner | Spreading the Word | Don't be afraid of FUD | Strengthening the Chain |
| Devoted Litecoiner | Kill the FUD! | MimbleWimble User | — |
| Silver Maximalist | The Silver Throne | — | — |

- **Mint fee** : 0.01 zkLTC per NFT
- **Royalties** : 2.5% on resale (EIP-2981)
- **Transferable** — tradeable on any EVM-compatible marketplace

---

## 🔧 Tech Stack

- **Network** — LiteForge Testnet · Chain ID 4441
- **Burn Contract** — [`0x0AD3f776C45FF457d2d8e211A3174A4Db201b656`](https://liteforge.explorer.caldera.xyz/address/0x0AD3f776C45FF457d2d8e211A3174A4Db201b656)
- **NFT Contract** — [`0xd278847e150B8fa3bf8fbAF46c0B780A029A9217`](https://liteforge.explorer.caldera.xyz/address/0xd278847e150B8fa3bf8fbAF46c0B780A029A9217)
- **Frontend** — Vanilla HTML/CSS/JS · Ethers.js v6.7 (inline)
- **NFT Artwork** — IPFS via Pinata
- **Hosting** — Vercel

---

## 📁 Structure

```
the-silver-void/
├── contracts/
│   ├── SilverVoid.sol       # Burn protocol — sends 100% to 0x000...dEaD
│   └── SilverVoidNFT.sol    # ERC-721 + EIP-2981 royalties
├── frontend/
│   └── index.html           # Full DApp — single file
└── README.md
```

---

## 🚀 How to Use

1. Add LiteForge Testnet to MetaMask
   - Network: LiteForge · Chain ID: `4441`
   - RPC: `https://liteforge.rpc.caldera.xyz/http`
2. Get zkLTC from the faucet at [testnet.litvm.com](https://testnet.litvm.com)
3. Go to [the-silver-void.vercel.app](https://the-silver-void.vercel.app)
4. Connect wallet → choose amount → burn → claim your rank & NFT

---

## 🛣️ Roadmap

- [ ] Mainnet deployment on LitVM
- [ ] NFT marketplace integration
- [ ] Mobile app
- [ ] DAO governance for burn thresholds

---

## 📜 License

MIT — open-source, cypherpunk spirit.

---

*Built for the Litecoin Hackathon 2025. The chain remembers.*

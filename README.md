# The SiŁver Void

> *"Lost coins only make everybody else's coins worth slightly more. Think of it as a donation to everyone."* — Satoshi Nakamoto

**The Silver Void** is the first **Cypherpunk Pensieve** and deflationary burn ritual ecosystem built on **LiteForge Testnet (LitVM, Chain ID 4441)**. Sacrifice zkLTC forever, unlock permanent on-chain ranks, climb the Duelist leaderboard, collect exclusive NFT relics, and trade them on **The Void Store**.

Engrave your legacy in the history of Litecoin.

🔗 **Live Demo** → [the-silver-void.vercel.app](https://the-silver-void.vercel.app)

---

## ⬡ What is it?

A single-page Web3 DApp designed as a dark-fantasy MMO hub where users interact with the Litecoin ecosystem through pure sacrifice and action:

- **The Ritual (Burn):** Sacrifice zkLTC into the dead address (`0x000...dEaD`) to earn on-chain ranks.
- **The Duel Chamber (PvP):** Challenge other players to commit-reveal Rock-Paper-Scissors duels for a share of the stake.
- **The Duelist Saga:** A 4-chapter narrative arc of mintable NFTs, unlocked by genuine duel milestones (not burn).
- **The Void Store:** A built-in marketplace to buy, sell, and trade every relic — rank NFTs and Saga pieces alike.
- **Names & Avatars:** Set a display name and choose an avatar from your unlocked ranks, feats, and Saga chapters.
- **The Hall of Feats:** A WoW-style achievement tracker spanning burning, duels, and the Saga.

**No staking. No yield. Pure sacrifice & competition. For the Litecoin ecosystem.**

---

## ⚔️ The Duel Chamber (Deflationary PvP)

Players engage in commit-reveal **Rock, Paper, Scissors** duels, staking 0.1 / 0.5 / 1 / 5 zkLTC. The creator commits a hidden choice; the opponent joins with a visible one; the creator then reveals within a 6-hour window (or the opponent can claim the pot on timeout).

### 📊 The Economic Engine

Every resolved duel splits the total pot:

- **🏆 75% Winner Share** — the victor takes the pot.
- **🔥 20% Burn Tax** — sent to `0x000...dEaD` forever.
- **👑 5% Creator Fee** — funds future development.

### 🥇 The Duelist Leaderboard

All-time ranking based on resolved duels: **Win +2 · Tie +1 · Loss +0**. Displayed alongside each player's chosen name and avatar.

---

## 📖 The Duelist Saga

A 4-chapter mintable NFT collection, unlocked purely by combat milestones — not burning:

| Chapter | Unlock condition |
|---|---|
| **The Awakening** | Play your first duel |
| **Lightning Adept** | Win 15 duels |
| **Sanctuary Glimpse** | Play 40 duels |
| **Guardian Ascended** | Play 84 duels |

Each milestone is **re-verified on-chain** at mint time by scanning the duel contract directly — eligibility can't be spoofed by a modified frontend. Mint price: **0.05 zkLTC**. Royalties: **2.5%** (EIP-2981).

---

## 🏪 The Void Store

A standalone marketplace contract for trading any ERC-721 relic — rank NFTs and Saga pieces alike. No escrow: relics stay in your wallet until the moment of sale.

- **80%** to the seller
- **17%** burned forever
- **3%** to the order

Every sale feeds the Void — trading and burning are the same act.

---

## ✏️ Names & Avatars

- **Display name:** unlocked once you reach the *Simple Holder* rank. First name is free; changing an existing one costs 0.05 zkLTC.
- **Avatars:** one per unlocked rank-pool relic (Common/Rare/Epic variants) and one per unlocked Saga chapter — switch freely, anytime, at no cost.

---

## 🏆 Hall of Feats

Tracks burning, duels, and Saga progress in one place, with real relic artwork shown for each Saga chapter (locked chapters appear grayed out with their unlock condition).

---

## 🎖️ Ranks of the Void

| Rank | Title | Requirement |
|---|---|---|
| **1 · Initiate** | Simple Holder | ≥ 0.5 zkLTC burned |
| **2 · Novice** | Apprentice Litecoiner | ≥ 5 zkLTC burned |
| **3 · Adept** | Devoted Litecoiner | ≥ 20 zkLTC burned |
| **4 · Elite** | Silver Maximalist | ≥ 100 zkLTC burned |

Each rank unlocks a unique NFT pool with Common, Rare, and Epic variants — each independently sellable on The Void Store.

---

## 🔧 Tech Stack & Architecture

- **Network:** LiteForge Testnet · Chain ID 4441
- **Contracts:**
  - **Burn Protocol (Pensieve):** `0x0AD3f776C45FF457d2d8e211A3174A4Db201b656` — sends 100% to `0x000...dEaD`
  - **Rank NFT Contract:** `0xd278847e150B8fa3bf8fbAF46c0B780A029A9217` — ERC-721 + EIP-2981 royalties
  - **Duel Contract:** `0x78b70AA24ca90690AD2b21d5c1980F55420A0AA1` — commit-reveal PvP, 75/20/5 split
  - **Duelist Saga Contract:** `0xBCe2079dFE9D8ef7ca5acC7690Da3aC4417A6145` — milestone-gated ERC-721, on-chain eligibility re-check
  - **The Void Store:** `0xc3f26f69e704f5c0feC4D5B5f4bA5f39154Afb01` — generic marketplace, 80/17/3 split
- **Backend:** Vercel serverless functions + Upstash Redis (KV) — encrypted secret backup, names, avatars
- **Frontend:** Vanilla HTML5 / CSS3 / JavaScript, `ethers.js v6`
- **NFT Artwork & Metadata:** IPFS via Pinata
- **Hosting:** Vercel

```
the-silver-void/
├── contracts/
│   ├── SilverVoid.sol              # Burn protocol — sends 100% to dead address
│   ├── SilverVoidNFT.sol           # Rank NFTs — ERC-721 + EIP-2981 royalties
│   ├── SilverVoidPFC.sol           # Duel contract — commit-reveal PvP
│   ├── SilverVoidDuelistSaga.sol   # Saga NFTs — milestone-gated, on-chain verified
│   └── SilverVoidStore.sol         # The Void Store — generic NFT marketplace
├── frontend/
│   ├── index.html                  # Main DApp & immersive lore intro
│   └── api/
│       ├── secret.js               # Encrypted cross-device secret backup
│       ├── username.js             # Display name storage
│       └── avatar.js               # Avatar selection storage
└── README.md
```

---

## About

Burn zkLTC into the void. Duel for glory. Trade your relics. A deflationary ritual ecosystem built on LiteForge Testnet, where sacrifice is proof.

[the-silver-void.vercel.app](https://the-silver-void.vercel.app)

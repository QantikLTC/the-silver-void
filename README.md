# The SiŁver Void

> *"Lost coins only make everybody else's coins worth slightly more. Think of it as a donation to everyone."* — Satoshi Nakamoto

**The Silver Void** is the first **Cypherpunk Pensieve** and deflationary burn ritual ecosystem built on **LiteForge Testnet (LitVM, Chain ID 4441)**. Sacrifice zkLTC forever, unlock permanent on-chain ranks, collect exclusive NFT rewards, and face other players in high-stakes deflationary PvP duels. 

Engrave your legacy in the history of Litecoin.

🔗 **Live Demo** → [the-silver-void.vercel.app](https://the-silver-void.vercel.app)

---

## ⬡ What is it?

A single-page Web3 DApp designed as a dark-fantasy MMO hub where users interact with the Litecoin ecosystem through pure sacrifice and action:
* **The Ritual (Burn):** Sacrifice zkLTC tokens into the dead address (`0x000...dEaD`) to earn on-chain ranks.
* **The Catalyst Arena (New PvP):** Challenge other players to instant Rock-Paper-Scissors (PFC) duels.
* **The Hall of Feats (New Quests):** Track your progress with a WoW-style achievement system.
* **NFT Rewards:** Unlock unique collectible badges per rank, claimable on-chain with a built-in creator revenue model.

**No staking. No yield. Pure sacrifice & competition. For the Litecoin ecosystem.**

---

## ⚔️ The Catalyst Arena (Deflationary PvP)

The Arena brings utility and high-stakes dopamine to the ecosystem. Players engage in instant **Rock, Paper, Scissors** duels using their $zkLTC tokens.

### 📊 The Economic Engine (Business Model)
To ensure long-term health and token scarcity, every single duel follows a dual-taxation rule on the total prize pool:
* **🔥 20% Burn Tax:** Cast directly into the void (`0x000...dEaD`) forever. Making $LTC scarcer with every play.
* **👑 5% Creator Fee (Royalties):** Sent automatically to the developer wallet to fund future expansions and rewards.
* **🏆 75% Winner Share:** The victorious warrior takes the remaining pool instantly.

---

## 🏆 Hall of Feats (Achievement Tracker)

Inspired by classic MMO achievements, the **Hall of Feats** tracks your actions on-chain and locally, giving players a sense of progression.

* **First Blood:** Win your very first PvP match in the Catalyst Arena `[ 0 / 1 ]`
* **Arena Gladiator:** Defeat your opponents and successfully claim 5 duel victories `[ 0 / 5 ]`
* **The Mind Games Master:** Go on a rampage and secure a 3-win streak `[ 0 / 3 ]`
* **Spark of the Void:** Trigger your first zkLTC burn through a PvP duel `[ 0 / 1 ]`
* **The Eternal Purifier:** Help the deflation effort by causing a total of 5.0 zkLTC to be burned `[ 0.0 / 5.0 zkLTC ]`

---

## 🎖️ Ranks of the Void

| Rank | Title | Requirement |
| :--- | :--- | :--- |
| **1 · Initiate** | Simple Holder | ≥ 0.5 zkLTC burned |
| **2 · Novice** | Apprentice Litecoiner | ≥ 5 zkLTC burned |
| **3 · Adept** | Devoted Litecoiner | ≥ 20 zkLTC burned |
| **4 · Elite** | Silver Maximalist | ≥ 100 zkLTC burned |

*Each rank unlocks a unique NFT pool with Common, Rare, and Epic variants.*

---

## 🎴 NFT Collection & Marketplace Vision

* **Mint fee:** 0.01 zkLTC per NFT
* **Royalties:** 2.5% on secondary market resale (EIP-2981)
* **Utility:** Fully transferable, tradeable on any EVM-compatible marketplace. High-rank variants (like *The Silver Throne*) represent ultimate ecosystem prestige.

---

## 🔧 Tech Stack & Architecture

* **Network:** LiteForge Testnet · Chain ID 4441
* **Contracts:**
  * **Burn Protocol:** `0x0AD3f776C45FF457d2d8e211A3174A4Db201b656` (Sends 100% to `0x000...dEaD`)
  * **NFT Contract:** `0xd278847e150B8fa3bf8fbAF46c0B780A029A9217` (ERC-721 + EIP-2981 royalties)
  * **Arena Contract:** `0x0e4523eb...` (PvP logic, 20% burn, 5% royalties)
* **Frontend:** Vanilla HTML5 / CSS3 / JavaScript (Modularized architecture with externalized `ethers.js v6.7`)
* **NFT Artwork:** IPFS via Pinata
* **Hosting:** Vercel

```text
the-silver-void/
├── contracts/
│   ├── SilverVoid.sol       # Burn protocol — sends 100% to dead address
│   ├── SilverVoidNFT.sol    # ERC-721 + EIP-2981 royalties
│   └── SilverVoidArena.sol  # PvP Rock-Paper-Scissors contract with 20% burn / 5% fee
├── frontend/
│   ├── index.html           # Main DApp & Immersive Lore Intro
│   └── ethers.js            # Externalized light-weight web3 provider
└── README.md

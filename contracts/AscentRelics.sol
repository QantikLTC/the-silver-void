// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title AscentRelics
 * @notice The twelve relics of the Ascent — earned by duelling, gated by burn.
 *
 * ═══ THE RULE ═══
 *
 *   Your rank decides which relics can drop. Duels decide when they drop.
 *
 * The Order opens the chest, the Arena turns the key. Burning never yields a
 * relic on its own, and duelling never raises a rank. Two systems, one object.
 *
 * ═══ WHY COMMIT-REVEAL ═══
 *
 * LitVM has no VRF. A naive on-chain roll — keccak of timestamp and sender —
 * is manipulable: a caller simulates the transaction, sees the outcome, and
 * only broadcasts when it favours them. With a Legendary at 0.5% and relics
 * that resell, that would break the economy on day one.
 *
 * So: commit first, reveal later, and the seed is fixed at commit time from a
 * block hash the player cannot know yet.
 *
 * ═══ WHY AN ABANDONED COMMIT COSTS THE DRAW ═══
 *
 * Once the block is mined, a player can compute their own result before
 * revealing. If failing to reveal cost nothing — or worse, granted a Common —
 * the rational move would be to reveal only the good rolls and walk away from
 * the rest. Free rerolls, and the published odds become fiction.
 *
 * Committing therefore spends the credit immediately. Not revealing loses the
 * relic entirely. Nobody else may claim the roll either: a public claim would
 * let bots harvest every abandoned Legendary.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ═══ CHANGES IN THIS REVISION ═══
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 1. THE FORGE. Three relics of one rarity become one of the rarity above.
 *
 *    Three pulls in four give a Common. On mainnet a pull costs real losses
 *    across several duels, and in three cases out of four the player receives
 *    something they have no use for. The problem was never the price — it was
 *    that the most frequent outcome led nowhere.
 *
 *    The forge does not make pulls cheaper. It makes Commons worth keeping.
 *
 *    Deliberately NOT a second lottery: three Commons give an Uncommon, for
 *    certain. Putting chance here would only move the frustration one rung up.
 *    A guaranteed tier gives the player something to plan for.
 *
 *    Deliberately NOT rank-gated, unlike the draw. The draw rewards what you
 *    burned; the forge rewards what you collected. A rank 1 who buys three
 *    Rares on the Store has paid for their Epic in zkLTC rather than in
 *    offerings — a different road, not a shortcut, and the one thing that
 *    gives the middle rarities a reason to circulate.
 *
 * 2. DUELS_PER_DRAW: 4 → 3.
 *
 * 3. REVEAL_WINDOW: 64 → 200 blocks. At ~0.25s per block the old window gave
 *    players sixteen seconds to sign the second transaction. Fifty is still
 *    short enough that nobody sits on a commit, and the seed is fixed anyway.
 *
 * ═══ DEPLOYMENT NOTE ═══
 *
 * drawsUsed, pityCounter and every minted relic live in THIS contract. A fresh
 * deployment starts empty: pulls earned against the previous one are gone, and
 * any pending commit can never be revealed. Announce the migration, let players
 * spend what they hold, and add the retired address to the front-end's legacy
 * list so old relics stay visible in the Codex.
 */

library Strings {
    function toString(uint256 value) internal pure returns (string memory) {
        if (value == 0) return "0";
        uint256 temp = value;
        uint256 digits;
        while (temp != 0) { digits++; temp /= 10; }
        bytes memory buffer = new bytes(digits);
        while (value != 0) {
            digits--;
            buffer[digits] = bytes1(uint8(48 + uint256(value % 10)));
            value /= 10;
        }
        return string(buffer);
    }
}

library Base64 {
    string internal constant TABLE =
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

    function encode(bytes memory data) internal pure returns (string memory) {
        if (data.length == 0) return "";
        string memory table = TABLE;
        uint256 encodedLen = 4 * ((data.length + 2) / 3);
        string memory result = new string(encodedLen + 32);
        assembly {
            let tablePtr := add(table, 1)
            let resultPtr := add(result, 32)
            for { let i := 0 } lt(i, mload(data)) { } {
                i := add(i, 3)
                let input := and(mload(add(data, i)), 0xffffff)
                let out := mload(add(tablePtr, and(shr(18, input), 0x3F)))
                out := shl(8, out)
                out := add(out, and(mload(add(tablePtr, and(shr(12, input), 0x3F))), 255))
                out := shl(8, out)
                out := add(out, and(mload(add(tablePtr, and(shr(6, input), 0x3F))), 255))
                out := shl(8, out)
                out := add(out, and(mload(add(tablePtr, and(input, 0x3F))), 255))
                out := shl(224, out)
                mstore(resultPtr, out)
                resultPtr := add(resultPtr, 4)
            }
            switch mod(mload(data), 3)
            case 1 { mstore(sub(resultPtr, 2), shl(240, 0x3d3d)) }
            case 2 { mstore(sub(resultPtr, 1), shl(248, 0x3d)) }
            mstore(result, encodedLen)
        }
        return result;
    }
}

interface IBurnContract {
    function getBurnerInfo(address user) external view returns (uint256, uint8, string memory);
}

interface IDuelContract {
    function duelCountOf(address player) external view returns (uint256);
}

contract AscentRelics {

    using Strings for uint256;

    // ═══════════════════════════════════════════
    // CONFIG
    // ═══════════════════════════════════════════

    address public immutable BURN_CONTRACT;
    address public immutable DUEL_CONTRACT;
    // No fee recipient: drawing costs only gas. A relic is earned by duelling,
    // not bought — there is nothing to collect here.

    /// @notice Where the forge fee goes. Not a treasury: an address nobody
    ///         holds the key to, including us.
    address public constant DEAD_ADDRESS = 0x000000000000000000000000000000000000dEaD;

    uint256 public constant DUELS_PER_DRAW = 3;

    /// @notice Reveal window, in blocks. Long enough for a person, short
    ///         enough that nobody sits on a commit waiting for a better one —
    ///         and the seed is fixed regardless.
    uint256 public constant REVEAL_WINDOW = 200;

    /// @notice Blocks to wait before the seed block. The player cannot know
    ///         this hash when committing.
    uint256 public constant SEED_OFFSET = 2;

    /// @notice Consecutive Common/Uncommon pulls before the next roll skips
    ///         them entirely. Never guarantees the Legendary.
    uint8 public constant PITY_THRESHOLD = 15;

    uint8 public constant ITEM_COUNT = 12;

    /// @notice Relics consumed per forge. Four would make the full Common →
    ///         Legendary cascade cost 256 Commons instead of 81; three keeps
    ///         the ladder walkable for someone who actually plays.
    uint8 public constant FORGE_INPUT = 3;

    /// @notice Burned in full. Small, but enough that forging stays a choice
    ///         rather than a reflex — and it feeds the same fire as the rest.
    uint256 public constant FORGE_COST = 0.002 ether;

    string public name   = "The Silver Void - Ascent Relics";
    string public symbol = "SVAR";

    // Rarity: 0 Common, 1 Uncommon, 2 Rare, 3 Epic, 4 Legendary
    // Global weights in basis points: 75% / 18% / 5% / 1.5% / 0.5%
    uint16[5] private RARITY_BP = [7500, 1800, 500, 150, 50];

    // ═══════════════════════════════════════════
    // ERC-721 STORAGE
    // ═══════════════════════════════════════════

    uint256 private _nextTokenId = 1;

    mapping(uint256 => address) private _owners;
    mapping(address => uint256) private _balances;
    mapping(uint256 => address) private _tokenApprovals;
    mapping(address => mapping(address => bool)) private _operatorApprovals;

    /// @notice tokenId => itemType (1..12). Metadata carries this so the Codex
    ///         can group duplicates: forty tokens read as "Common #1 x23".
    mapping(uint256 => uint8) public tokenItem;
    mapping(uint256 => uint256) public tokenMintedAt;

    /// @notice Copies in existence per item — real scarcity, on-chain.
    mapping(uint8 => uint256) public mintedPerItem;

    /// @notice Copies destroyed per item, so the Codex can show a true
    ///         circulating figure once the forge starts eating duplicates.
    mapping(uint8 => uint256) public burnedPerItem;

    /// @notice Per-owner copies of each item, maintained on mint and transfer,
    /// so the Codex reads an inventory in O(1) instead of scanning every token.
    mapping(address => mapping(uint8 => uint256)) public ownedOf;
    uint256 public totalPulls;

    /// @notice Relics destroyed by the forge, all items combined.
    uint256 public totalForged;

    /// @notice zkLTC sent to the dead address by forge fees.
    uint256 public totalBurnedWei;

    // ═══════════════════════════════════════════
    // DRAW STATE
    // ═══════════════════════════════════════════

    struct Commit {
        uint64  blockNumber;    // block the commit landed in
        uint64  pullsAtCommit;  // frozen here so the seed can't shift under a
                                // concurrent reveal — see revealDraw()
        bool    pending;
    }

    mapping(address => Commit)  public commitOf;
    mapping(address => uint256) public drawsUsed;
    mapping(address => uint8)   public pityCounter;

    event DrawCommitted(address indexed player, uint256 seedBlock, uint256 expiresAt);
    event RelicPulled(address indexed player, uint8 itemType, uint8 rarity, uint256 tokenId);
    event DrawAbandoned(address indexed player);
    event RelicsForged(
        address indexed player,
        uint8 fromRarity,
        uint8 toRarity,
        uint256[] burned,
        uint256 tokenId
    );

    event Transfer(address indexed from, address indexed to, uint256 indexed tokenId);
    event Approval(address indexed owner, address indexed approved, uint256 indexed tokenId);
    event ApprovalForAll(address indexed owner, address indexed operator, bool approved);

    constructor(address burnContract, address duelContract) {
        BURN_CONTRACT = burnContract;
        DUEL_CONTRACT = duelContract;
    }

    // ═══════════════════════════════════════════
    // ITEM TABLE
    // ═══════════════════════════════════════════

    /// @notice Burn rank required to have an item in your pool (1..4).
    function itemRank(uint8 id) public pure returns (uint8) {
        if (id <= 3)  return 1;   // 1,2 Common · 3 Uncommon
        if (id <= 6)  return 2;   // 4 Common · 5 Uncommon · 6 Rare
        if (id <= 9)  return 3;   // 7 Common · 8 Rare · 9 Epic
        if (id <= 12) return 4;   // 10 Common · 11 Uncommon · 12 Legendary
        revert("bad item");
    }

    function itemRarity(uint8 id) public pure returns (uint8) {
        if (id == 1 || id == 2) return 0;
        if (id == 3)  return 1;
        if (id == 4)  return 0;
        if (id == 5)  return 1;
        if (id == 6)  return 2;
        if (id == 7)  return 0;
        if (id == 8)  return 2;
        if (id == 9)  return 3;
        if (id == 10) return 0;
        if (id == 11) return 3;   // Lightning Adept — Epic, closing the rank-4 C/E/L set
        if (id == 12) return 4;
        revert("bad item");
    }

    // ═══════════════════════════════════════════
    // ELIGIBILITY
    // ═══════════════════════════════════════════

    function burnRankOf(address player) public view returns (uint8) {
        try IBurnContract(BURN_CONTRACT).getBurnerInfo(player) returns (uint256 amount, uint8, string memory) {
            if (amount >= 100 ether) return 4;
            if (amount >= 20 ether)  return 3;
            if (amount >= 5 ether)   return 2;
            if (amount >= 0.5 ether) return 1;
            return 0;
        } catch {
            return 0;
        }
    }

    /// @notice Duels counted toward draws. NOTE: this reads the single duel
    /// contract passed at deploy. The arena has run on two contracts; only the
    /// one wired here counts, so a player's pre-migration duels do not earn
    /// draws. That is deliberate for v1 — the alternative is trusting an
    /// off-chain sum. If the legacy history must count, deploy with a duel
    /// contract that aggregates both, not this one.
    function duelsOf(address player) public view returns (uint256) {
        try IDuelContract(DUEL_CONTRACT).duelCountOf(player) returns (uint256 n) {
            return n;
        } catch {
            return 0;
        }
    }

    function drawsEarned(address player) public view returns (uint256) {
        return duelsOf(player) / DUELS_PER_DRAW;
    }

    function drawsAvailable(address player) public view returns (uint256) {
        uint256 earned = drawsEarned(player);
        uint256 used = drawsUsed[player];
        return earned > used ? earned - used : 0;
    }

    /// @notice Item ids currently in this player's pool.
    function poolOf(address player) public view returns (uint8[] memory ids) {
        uint8 rank = burnRankOf(player);
        uint8 n = 0;
        for (uint8 i = 1; i <= ITEM_COUNT; i++) if (itemRank(i) <= rank) n++;
        ids = new uint8[](n);
        uint8 k = 0;
        for (uint8 i = 1; i <= ITEM_COUNT; i++) if (itemRank(i) <= rank) ids[k++] = i;
    }

    // ═══════════════════════════════════════════
    // DRAW — COMMIT
    // ═══════════════════════════════════════════

    /**
     * @notice Spend a draw and lock in a future block as the seed.
     * @dev The credit is consumed here, not at reveal. Abandoning the commit
     *      loses the relic — see the note at the top of this file.
     */
    function commitDraw() external {
        require(burnRankOf(msg.sender) >= 1, "burn first");
        require(drawsAvailable(msg.sender) > 0, "no draws");
        require(!commitOf[msg.sender].pending, "reveal first");

        drawsUsed[msg.sender] += 1;
        commitOf[msg.sender] = Commit({
            blockNumber: uint64(block.number),
            pullsAtCommit: uint64(totalPulls),
            pending: true
        });

        emit DrawCommitted(msg.sender,
                           block.number + SEED_OFFSET,
                           block.number + SEED_OFFSET + REVEAL_WINDOW);
    }

    /// @notice True once the seed block exists and the window is still open.
    function canReveal(address player) external view returns (bool) {
        Commit memory c = commitOf[player];
        if (!c.pending) return false;
        uint256 seedBlock = uint256(c.blockNumber) + SEED_OFFSET;
        return block.number > seedBlock && block.number <= seedBlock + REVEAL_WINDOW;
    }

    /// @notice Blocks left to reveal, 0 when expired or nothing pending.
    function blocksLeft(address player) external view returns (uint256) {
        Commit memory c = commitOf[player];
        if (!c.pending) return 0;
        uint256 deadline = uint256(c.blockNumber) + SEED_OFFSET + REVEAL_WINDOW;
        return block.number >= deadline ? 0 : deadline - block.number;
    }

    // ═══════════════════════════════════════════
    // DRAW — REVEAL
    // ═══════════════════════════════════════════

    /**
     * @notice Mint the relic the committed seed determined.
     * @dev The outcome was fixed the moment the seed block was mined. A player
     *      can read it before revealing; they simply cannot change it, and
     *      walking away costs them the draw.
     */
    function revealDraw() external returns (uint256 tokenId) {
        Commit memory c = commitOf[msg.sender];
        require(c.pending, "no draw");

        uint256 seedBlock = uint256(c.blockNumber) + SEED_OFFSET;
        require(block.number > seedBlock, "too early");
        require(block.number <= seedBlock + REVEAL_WINDOW, "window closed");

        bytes32 bh = blockhash(seedBlock);
        // Beyond 256 blocks the hash is unavailable. The window is now 200
        // blocks plus the 2-block offset, so this can bite in a bad reorg —
        // hence the explicit check rather than a silent zero seed.
        require(bh != bytes32(0), "no seed");

        delete commitOf[msg.sender];

        // Seeded with the pull count captured AT COMMIT, not the live one: if it
        // used the current totalPulls, another player's reveal during the
        // window would shift this modulo, letting a caller wait for a result
        // they like. Freezing it closes that reroll.
        uint256 seed = uint256(keccak256(abi.encodePacked(bh, msg.sender, c.pullsAtCommit)));

        uint8 itemType = _roll(msg.sender, seed);
        uint8 rarity = itemRarity(itemType);

        // Pity tracks dry spells, and only where a Rare+ is reachable at all —
        // a rank 1 pool has none, so the counter would climb forever.
        if (rarity >= 2) pityCounter[msg.sender] = 0;
        else if (_hasRarePlus(msg.sender)) pityCounter[msg.sender] += 1;

        tokenId = _nextTokenId++;
        _owners[tokenId] = msg.sender;
        _balances[msg.sender]++;
        tokenItem[tokenId] = itemType;
        tokenMintedAt[tokenId] = block.timestamp;
        mintedPerItem[itemType]++;
        ownedOf[msg.sender][itemType]++;
        totalPulls++;

        emit Transfer(address(0), msg.sender, tokenId);
        emit RelicPulled(msg.sender, itemType, rarity, tokenId);
    }

    /// @notice Give up a commit whose window has closed, so a new draw can be
    ///         made. The lost credit is not refunded.
    function clearExpiredCommit() external {
        Commit memory c = commitOf[msg.sender];
        require(c.pending, "nothing pending");
        require(block.number > uint256(c.blockNumber) + SEED_OFFSET + REVEAL_WINDOW,
                "still open");
        delete commitOf[msg.sender];
        emit DrawAbandoned(msg.sender);
    }

    // ═══════════════════════════════════════════
    // THE FORGE
    // ═══════════════════════════════════════════

    /**
     * @notice Destroy FORGE_INPUT relics of one rarity, mint one of the rarity
     *         above.
     *
     * @dev Three things this deliberately does NOT do:
     *
     *      It does not check your rank. See the header note — the forge is the
     *      collector's road, not the burner's.
     *
     *      It does not stop you burning your last copy. If someone wants to
     *      sacrifice the only Epic they own for a shot at the tier above, that
     *      is their call. The interface warns; the contract obeys.
     *
     *      It does not use commit-reveal. The TIER is guaranteed, so the only
     *      thing chance decides is which item within it — and at Legendary
     *      there is only one. A caller who simulates and retries can at best
     *      steer between two Epics, at the cost of gas each time. Not worth a
     *      two-transaction flow.
     *
     * @param tokenIds Exactly FORGE_INPUT tokens you own, all of one rarity.
     */
    function forge(uint256[] calldata tokenIds)
        external
        payable
        returns (uint256 tokenId)
    {
        require(msg.value == FORGE_COST, "bad cost");
        require(tokenIds.length == FORGE_INPUT, "bad count");

        uint8 rarity = itemRarity(tokenItem[tokenIds[0]]);
        require(rarity < 4, "top tier");
        uint8 target = rarity + 1;

        for (uint256 i = 0; i < FORGE_INPUT; i++) {
            uint256 id = tokenIds[i];
            require(_owners[id] == msg.sender, "not yours");
            // The same token passed twice would decrement the balance twice.
            // This is the one guard kept — it protects the contract's books,
            // not the player's judgement.
            for (uint256 j = 0; j < i; j++) {
                require(tokenIds[j] != id, "dup id");
            }
            require(itemRarity(tokenItem[id]) == rarity, "mixed tiers");
        }

        // ── Destroy ──────────────────────────────────────────────────────
        for (uint256 i = 0; i < FORGE_INPUT; i++) {
            uint256 id = tokenIds[i];
            uint8 it = tokenItem[id];

            delete _tokenApprovals[id];
            _owners[id] = address(0);
            _balances[msg.sender]--;
            ownedOf[msg.sender][it]--;
            burnedPerItem[it]++;

            emit Transfer(msg.sender, address(0), id);
        }
        totalForged += FORGE_INPUT;

        // ── Mint ─────────────────────────────────────────────────────────
        // The tier is certain; which relic inside it is not. Without that,
        // everyone would forge the same card and the collection would stop
        // being one.
        uint256 seed = uint256(
            keccak256(abi.encodePacked(blockhash(block.number - 1), msg.sender, totalPulls, tokenIds))
        );
        uint8 itemType = _pickInRarity(target, seed);

        tokenId = _nextTokenId++;
        _owners[tokenId] = msg.sender;
        _balances[msg.sender]++;
        tokenItem[tokenId] = itemType;
        tokenMintedAt[tokenId] = block.timestamp;
        mintedPerItem[itemType]++;
        ownedOf[msg.sender][itemType]++;

        // Forging does NOT touch totalPulls: that counter measures draws won
        // in the arena and seeds the commit-reveal. Mixing the two would
        // corrupt both.

        // A forged Rare+ ends the dry spell as surely as a drawn one.
        if (target >= 2) pityCounter[msg.sender] = 0;

        totalBurnedWei += msg.value;
        (bool sent, ) = DEAD_ADDRESS.call{value: msg.value}("");
        require(sent, "burn failed");

        emit Transfer(address(0), msg.sender, tokenId);
        emit RelicsForged(msg.sender, rarity, target, tokenIds, tokenId);
    }

    /// @dev Picks an item of a given rarity among ALL items of that rarity —
    ///      no rank filter, unlike _roll(). That difference is the whole point
    ///      of the forge.
    function _pickInRarity(uint8 rarity, uint256 seed) private pure returns (uint8) {
        uint8 count = 0;
        for (uint8 i = 1; i <= ITEM_COUNT; i++) {
            if (itemRarity(i) == rarity) count++;
        }
        require(count > 0, "empty tier");

        uint256 pick = seed % count;
        uint8 seen = 0;
        for (uint8 i = 1; i <= ITEM_COUNT; i++) {
            if (itemRarity(i) == rarity) {
                if (seen == pick) return i;
                seen++;
            }
        }
        revert("pick failed");
    }

    /// @notice How many forges this player could perform, per rarity (0..3).
    ///         Counts every copy, last ones included — the interface decides
    ///         what to warn about, the contract only reports.
    function forgeableOf(address player) external view returns (uint8[4] memory possible) {
        for (uint8 r = 0; r < 4; r++) {
            uint256 owned = 0;
            for (uint8 i = 1; i <= ITEM_COUNT; i++) {
                if (itemRarity(i) == r) owned += ownedOf[player][i];
            }
            possible[r] = uint8(owned / FORGE_INPUT);
        }
    }

    // ═══════════════════════════════════════════
    // ROLL
    // ═══════════════════════════════════════════

    function _hasRarePlus(address player) private view returns (bool) {
        return burnRankOf(player) >= 2;   // the first Rare appears at rank 2
    }

    /**
     * @dev Weights are normalised over the rarities actually present in the
     *      pool — a rank 1 player has no Epic to lose 1.5% into, so their 75/18
     *      becomes ~80.6/19.4. One pass, no fallback to a neighbouring rarity:
     *      a fallback would quietly distort both the odds and the pity counter.
     */
    function _roll(address player, uint256 seed) private view returns (uint8) {
        uint8 rank = burnRankOf(player);

        bool pityActive = pityCounter[player] >= PITY_THRESHOLD && _hasRarePlus(player);

        // Which rarities exist in this pool?
        bool[5] memory present;
        for (uint8 i = 1; i <= ITEM_COUNT; i++) {
            if (itemRank(i) <= rank) present[itemRarity(i)] = true;
        }
        // Pity: skip Common and Uncommon entirely for this roll.
        if (pityActive) { present[0] = false; present[1] = false; }

        uint256 total = 0;
        for (uint8 r = 0; r < 5; r++) if (present[r]) total += RARITY_BP[r];
        require(total > 0, "empty pool");

        uint256 pick = seed % total;
        uint8 chosen = 0;
        uint256 acc = 0;
        for (uint8 r = 0; r < 5; r++) {
            if (!present[r]) continue;
            acc += RARITY_BP[r];
            if (pick < acc) { chosen = r; break; }
        }

        // Uniform among the items of that rarity inside the pool.
        uint8 count = 0;
        for (uint8 i = 1; i <= ITEM_COUNT; i++) {
            if (itemRank(i) <= rank && itemRarity(i) == chosen) count++;
        }
        uint256 idx = (seed >> 128) % count;
        uint8 seen = 0;
        for (uint8 i = 1; i <= ITEM_COUNT; i++) {
            if (itemRank(i) <= rank && itemRarity(i) == chosen) {
                if (seen == idx) return i;
                seen++;
            }
        }
        revert("roll failed");
    }

    // ═══════════════════════════════════════════
    // READ HELPERS
    // ═══════════════════════════════════════════

    /// @notice Copies of each item held, indexed 0..11 for items 1..12. Lets
    ///         the Codex show duplicates without walking every token.
    function inventoryOf(address player) external view returns (uint256[12] memory counts) {
        for (uint8 i = 1; i <= ITEM_COUNT; i++) counts[i - 1] = ownedOf[player][i];
    }

    /// @notice Copies still in circulation per item — minted minus forged.
    ///         mintedPerItem alone stops being the real figure once the forge
    ///         starts consuming duplicates.
    function circulatingOf(uint8 id) external view returns (uint256) {
        return mintedPerItem[id] - burnedPerItem[id];
    }

    function tokensOfOwner(address player, uint256 cursor, uint256 count)
        external view returns (uint256[] memory ids, uint256 nextCursor)
    {
        if (count > 200) count = 200;
        uint256 last = _nextTokenId;
        uint256[] memory buf = new uint256[](count);
        uint256 n = 0;
        uint256 i = cursor == 0 ? 1 : cursor;
        for (; i < last && n < count; i++) if (_owners[i] == player) buf[n++] = i;
        ids = new uint256[](n);
        for (uint256 k = 0; k < n; k++) ids[k] = buf[k];
        nextCursor = i < last ? i : 0;
    }

    function totalSupply() external view returns (uint256) { return _nextTokenId - 1; }

    // ═══════════════════════════════════════════
    // METADATA
    // ═══════════════════════════════════════════

    /// @dev Split in two halves on purpose. A single abi.encodePacked with
    ///      thirteen arguments overflows the EVM stack once the optimizer
    ///      runs ("stack too deep"): each argument holds a slot, and the
    ///      sixteen available run out. Two smaller calls, each releasing its
    ///      slots before the next, compile without viaIR.
    function tokenURI(uint256 tokenId) external view returns (string memory) {
        require(_owners[tokenId] != address(0), "no token");
        uint8 id = tokenItem[tokenId];
        return string(abi.encodePacked(
            "data:application/json;base64,",
            Base64.encode(bytes(string(abi.encodePacked(_uriHead(id), _uriTraits(id)))))
        ));
    }

    function _uriHead(uint8 id) private pure returns (string memory) {
        return string(abi.encodePacked(
            '{"name":"', _itemName(id),
            '","description":"A relic of the Ascent, drawn from the Void.","image":"',
            _imageURI(id),
            '","attributes":[{"trait_type":"Path","value":"The Ascent"},'
        ));
    }

    /// @dev Chaque helper garde peu d'arguments : c'est ce qui evite le
    ///      "stack too deep". Les chaines constantes sont pre-concatenees
    ///      dans le source plutot que separees par des virgules, ce qui coute
    ///      un slot de pile chacune.
    function _uriTraits(uint8 id) private view returns (string memory) {
        return string(abi.encodePacked(
            '{"trait_type":"Item","value":', uint256(id).toString(),
            '},{"trait_type":"Rarity","value":"', _rarityName(itemRarity(id)),
            '"},', _uriTail(id)
        ));
    }

    function _uriTail(uint8 id) private view returns (string memory) {
        return string(abi.encodePacked(
            '{"trait_type":"Rank Required","value":', uint256(itemRank(id)).toString(),
            '},{"trait_type":"Copies Minted","value":', mintedPerItem[id].toString(),
            '},{"trait_type":"Network","value":"LitVM"}]}'
        ));
    }

    function contractURI() external pure returns (string memory) {
        string memory json = '{"name":"The Silver Void - Ascent Relics","description":"Twelve relics of the Ascent. Your rank decides which can drop; duels decide when. Duplicates can be forged upward. Every pull is a commit-reveal draw settled on-chain.","external_link":"https://thesilvervoid.com"}';
        return string(abi.encodePacked("data:application/json;base64,", Base64.encode(bytes(json))));
    }

    function _rarityName(uint8 r) private pure returns (string memory) {
        if (r == 4) return "Legendary";
        if (r == 3) return "Epic";
        if (r == 2) return "Rare";
        if (r == 1) return "Uncommon";
        return "Common";
    }

    function _itemName(uint8 id) private pure returns (string memory) {
        if (id == 1)  return "The Litecoin Revelation";
        if (id == 2)  return "My First Coin";
        if (id == 3)  return "The Voyage Begins";
        if (id == 4)  return "Spreading the Word";
        if (id == 5)  return "Don't be afraid of FUD";
        if (id == 6)  return "Strengthening the Chain";
        if (id == 7)  return "Kill the FUD!";
        if (id == 8)  return "Guardian Ascended";
        if (id == 9)  return "MimbleWimble User";
        if (id == 10) return "Sanctuary Glimpse";
        if (id == 11) return "Lightning Adept";
        return "The Silver Throne";
    }

    /// The twelve relic illustrations on Arweave, in item order. Immutable once
    /// a token is minted against them, so these ids are final.
    function _imageURI(uint8 id) private pure returns (string memory) {
        if (id == 1)  return "https://arweave.net/h1I5MVU7UNMBBm5DXB8jS6jiNIUWVzI1V3AyzBHQCKY";
        if (id == 2)  return "https://arweave.net/qElCU7XNLHwFOqFl9epPG9FZXDcBPFeiVZren3s40ok";
        if (id == 3)  return "https://arweave.net/ylNeH5oLBfb5z4be4H1L3xjCUH8c6S6ydbt0CE-tYx0";
        if (id == 4)  return "https://arweave.net/Y-L7rBKz_TcEFS8hIvtPXiYepToZb6C945iCERYW_7Y";
        if (id == 5)  return "https://arweave.net/xnikO7f8_KVt1cgNgkIn-u7RV1CiOJSASmF5doqpWMs";
        if (id == 6)  return "https://arweave.net/NaXLY6FgpL1uGBJXrMfbYgT0HTKW5LRjmeXYHfjL7R8";
        if (id == 7)  return "https://arweave.net/ijg0tXZbynL04ANCVy12hfFqFSPg0ziT6pU_Ne62oAU";
        if (id == 8)  return "https://arweave.net/Jj7EFW_G9zwwD3RMMhMb_fsWM5fWh4v8kmqYaYz2X7Y";
        if (id == 9)  return "https://arweave.net/7dedZ6isXnVr85xW0wdq_UwOKCb62J_JwlxPbWdE6q8";
        if (id == 10) return "https://arweave.net/7gxV59_DIo4KTCmhK0TTXzKIY6ocvii6kBkri4f_xDc";
        if (id == 11) return "https://arweave.net/GCf13cwQE2VZuGB51U4XWReiME8p0TDMedWEJ1ewzKo";
        return "https://arweave.net/ESM4uD3tUCR9om88PU93gx4SRRCQZ7dAoLwcHXgjDVU";
    }

    // ═══════════════════════════════════════════
    // ERC-721
    // ═══════════════════════════════════════════

    function balanceOf(address owner) external view returns (uint256) {
        require(owner != address(0), "zero addr");
        return _balances[owner];
    }

    function ownerOf(uint256 tokenId) external view returns (address) {
        address owner = _owners[tokenId];
        require(owner != address(0), "no token");
        return owner;
    }

    function approve(address to, uint256 tokenId) external {
        address owner = _owners[tokenId];
        require(msg.sender == owner || _operatorApprovals[owner][msg.sender], "not auth");
        _tokenApprovals[tokenId] = to;
        emit Approval(owner, to, tokenId);
    }

    function getApproved(uint256 tokenId) external view returns (address) {
        return _tokenApprovals[tokenId];
    }

    function setApprovalForAll(address operator, bool approved) external {
        _operatorApprovals[msg.sender][operator] = approved;
        emit ApprovalForAll(msg.sender, operator, approved);
    }

    function isApprovedForAll(address owner, address operator) external view returns (bool) {
        return _operatorApprovals[owner][operator];
    }

    function transferFrom(address from, address to, uint256 tokenId) public {
        require(to != address(0), "zero addr");
        address owner = _owners[tokenId];
        require(owner == from, "not owner");
        require(
            msg.sender == owner ||
            _tokenApprovals[tokenId] == msg.sender ||
            _operatorApprovals[owner][msg.sender],
            "not auth"
        );
        _balances[from]--;
        _balances[to]++;
        _owners[tokenId] = to;
        uint8 it = tokenItem[tokenId];
        ownedOf[from][it]--;
        ownedOf[to][it]++;
        delete _tokenApprovals[tokenId];
        emit Transfer(from, to, tokenId);
    }

    // NOTE: these do not call onERC721Received. Relics are meant to move between
    // wallets and the project's own Store, not into arbitrary contracts, so the
    // receiver check is omitted. A marketplace expecting strict ERC721 safety
    // should be tested against this before listing.
    function safeTransferFrom(address from, address to, uint256 tokenId) external {
        transferFrom(from, to, tokenId);
    }

    function safeTransferFrom(address from, address to, uint256 tokenId, bytes calldata) external {
        transferFrom(from, to, tokenId);
    }

    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == 0x80ac58cd   // ERC-721
            || interfaceId == 0x5b5e139f   // ERC-721Metadata
            || interfaceId == 0x01ffc9a7;  // ERC-165
    }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title SilverVoidRelics
 * @notice The relics of The Silver Void — earned by duelling, gated by rank,
 *         forged upward — mainnet revision.
 *
 * ═══ THE RULE (unchanged) ═══
 *
 *   Your rank decides which relics can drop. Duels decide when they drop.
 *   The forge turns three relics of one rarity into one of the rarity above.
 *
 * ═══ WHAT CHANGED FROM THE TESTNET CONTRACT, AND WHY ═══
 *
 * 1. A CATALOGUE YOU CAN ADD TO — AND NOTHING ELSE.
 *    The twelve relics were hard-coded; adding one meant redeploying and
 *    wiping every draw. The catalogue now lives in storage. A curator address
 *    can ADD a relic (name, image, rarity, rank). It can never modify or
 *    remove one, never touch the odds, never touch a token. Curation can be
 *    handed to a multisig (two-step) and renounced for good, after which the
 *    collection is closed forever. Every addition is a public event.
 *    This is what lets Series II enter the game when its illustrations are
 *    ready — and each relic on the day its chapter unlocks on the Path.
 *
 *    One exception, for mistakes: while NO copy of a relic exists (none drawn,
 *    none forged), the curator may correct its name and image. The first copy
 *    freezes it forever. Rarity and rank are frozen from the moment of adding,
 *    since they shape the odds. A player can never see a relic they own change.
 *
 * 2. RANKS ARE READ FROM THE RITUAL. The testnet contract copied the rank
 *    thresholds (0.5 / 5 / 20 / 100). Mainnet thresholds differ, and a copy
 *    can drift. getRank() on the Ritual is now the only source.
 *
 * 3. DRAWS ARE READ FROM THE NEW ARENA, which counts decided duels only
 *    (no ties, no cancelled or dust duels) — see SilverVoidArena.
 *
 * 4. FORGE FEES BY TARGET RARITY, 95% BURNED FOR THE PLAYER.
 *    A flat 0.002 made the forge the cheapest road to the rarest relics. The
 *    fee now depends on the rarity forged (set at deployment). 95% is burned
 *    through the Ritual's burnFor(), so it lifts the forger's rank; 5% goes to
 *    the creator.
 *
 * ═══ KEPT FROM THE TESTNET CONTRACT ═══
 *
 *   Commit-reveal draws seeded by a future block hash, the pity counter, the
 *   rarity weights (75 / 18 / 5 / 1.5 / 0.5), the forge's guaranteed tier,
 *   on-chain metadata, per-owner inventory counters.
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
    string internal constant TABLE = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

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

interface IRitualR {
    function getRank(address user) external view returns (uint8);
    function burnFor(address beneficiary, uint8 source) external payable;
    function MIN_BURN() external view returns (uint256);
}

interface IArenaR {
    function duelCountOf(address player) external view returns (uint256);
}

contract SilverVoidRelics {

    using Strings for uint256;

    // ═══════════════════════════════════════════
    // CONSTANTS
    // ═══════════════════════════════════════════

    address public constant DEAD_ADDRESS = 0x000000000000000000000000000000000000dEaD;
    uint8   public constant SOURCE_FORGE = 3;

    uint256 public constant DUELS_PER_DRAW = 3;
    uint256 public constant REVEAL_WINDOW  = 200;   // blocks
    uint256 public constant SEED_OFFSET    = 2;     // blocks
    uint8   public constant PITY_THRESHOLD = 15;
    uint8   public constant FORGE_INPUT    = 3;
    uint256 public constant FORGE_BURN_BPS = 9500;  // 95% burned, 5% to the creator
    uint256 public constant MAX_ITEMS      = 64;    // a ceiling on the catalogue, so loops stay bounded

    // Rarity: 0 Common, 1 Uncommon, 2 Rare, 3 Epic, 4 Legendary
    uint16[5] private RARITY_BP = [7500, 1800, 500, 150, 50];

    string public name   = "The Silver Void - Relics";
    string public symbol = "SVR";

    // ═══════════════════════════════════════════
    // IMMUTABLE CONFIGURATION
    // ═══════════════════════════════════════════

    IRitualR public immutable RITUAL;
    IArenaR  public immutable ARENA;
    address  public immutable CREATOR;

    /// @notice Forge fee by TARGET rarity: to Uncommon, Rare, Epic, Legendary.
    uint256 public immutable FEE_TO_UNCOMMON;
    uint256 public immutable FEE_TO_RARE;
    uint256 public immutable FEE_TO_EPIC;
    uint256 public immutable FEE_TO_LEGENDARY;

    // ═══════════════════════════════════════════
    // CATALOGUE — append-only
    // ═══════════════════════════════════════════

    struct Relic {
        string name;
        string image;
        uint8  rarity;   // 0..4
        uint8  rank;     // 1..4, rank required to draw it
    }

    Relic[] private _catalogue;   // item id = index + 1

    /// @notice Who may add relics. address(0) once renounced: closed forever.
    address public curator;
    address public pendingCurator;

    // ═══════════════════════════════════════════
    // ERC-721 STORAGE
    // ═══════════════════════════════════════════

    uint256 private _nextTokenId = 1;
    mapping(uint256 => address) private _owners;
    mapping(address => uint256) private _balances;
    mapping(uint256 => address) private _tokenApprovals;
    mapping(address => mapping(address => bool)) private _operatorApprovals;

    mapping(uint256 => uint16)  public tokenItem;
    mapping(uint256 => uint256) public tokenMintedAt;
    mapping(uint16 => uint256)  public mintedPerItem;
    mapping(uint16 => uint256)  public burnedPerItem;
    mapping(address => mapping(uint16 => uint256)) public ownedOf;

    uint256 public totalPulls;
    uint256 public totalForged;
    uint256 public totalBurnedWei;

    mapping(address => uint256) public pendingWithdrawals;

    // ═══════════════════════════════════════════
    // DRAW STATE
    // ═══════════════════════════════════════════

    struct Commit { uint64 blockNumber; uint64 pullsAtCommit; bool pending; }
    mapping(address => Commit)  public commitOf;
    mapping(address => uint256) public drawsUsed;
    mapping(address => uint8)   public pityCounter;

    // ═══════════════════════════════════════════
    // EVENTS & ERRORS
    // ═══════════════════════════════════════════

    event RelicAdded(uint16 indexed itemId, string name, uint8 rarity, uint8 rank, string image);
    event RelicCorrected(uint16 indexed itemId, string name, string image);
    event CurationTransferStarted(address indexed from, address indexed to);
    event CurationTransferred(address indexed from, address indexed to);
    event CurationRenounced(address indexed by);

    event DrawCommitted(address indexed player, uint256 seedBlock, uint256 expiresAt);
    event RelicPulled(address indexed player, uint16 itemType, uint8 rarity, uint256 tokenId);
    event DrawAbandoned(address indexed player);
    event RelicsForged(address indexed player, uint8 fromRarity, uint8 toRarity, uint256[] burned, uint256 tokenId, uint256 fee);
    event PaymentDeferred(address indexed recipient, uint256 amount);
    event Withdrawn(address indexed recipient, uint256 amount);

    event Transfer(address indexed from, address indexed to, uint256 indexed tokenId);
    event Approval(address indexed owner, address indexed approved, uint256 indexed tokenId);
    event ApprovalForAll(address indexed owner, address indexed operator, bool approved);

    error BadConfig();
    error NotCurator();
    error NotPendingCurator();
    error CurationClosed();
    error BadRelic();
    error CatalogueFull();
    error RelicFrozen();
    error BadItem();
    error NoRank();
    error NoDraws();
    error RevealFirst();
    error NoDraw();
    error TooEarly();
    error WindowClosed();
    error NoSeed();
    error NothingPending();
    error StillOpen();
    error BadFee(uint256 sent, uint256 expected);
    error BadCount();
    error TopTier();
    error NotYours();
    error DuplicateId();
    error MixedTiers();
    error EmptyTier();
    error NoToken();
    error ZeroAddress();
    error NotAuthorized();
    error NotOwner();
    error NothingToWithdraw();
    error WithdrawFailed();

    // ═══════════════════════════════════════════
    // CONSTRUCTOR — Series I is seeded here
    // ═══════════════════════════════════════════

    /**
     * @param ritual     The Ritual (ranks, burnFor).
     * @param arena      The Arena (decided duels, for draws).
     * @param creator    Receives 5% of forge fees. Ledger or multisig on mainnet.
     * @param curator_   May add relics. Can be handed over or renounced.
     * @param forgeFees  Fee by target rarity: [to Uncommon, Rare, Epic, Legendary],
     *                   never decreasing, each at least 0 (a zero fee is allowed).
     */
    constructor(address ritual, address arena, address creator, address curator_, uint256[4] memory forgeFees) {
        if (ritual == address(0) || arena == address(0) || creator == address(0) || curator_ == address(0)) revert BadConfig();
        for (uint256 i = 1; i < 4; i++) if (forgeFees[i] < forgeFees[i - 1]) revert BadConfig();

        RITUAL = IRitualR(ritual);
        ARENA = IArenaR(arena);
        CREATOR = creator;
        FEE_TO_UNCOMMON  = forgeFees[0];
        FEE_TO_RARE      = forgeFees[1];
        FEE_TO_EPIC      = forgeFees[2];
        FEE_TO_LEGENDARY = forgeFees[3];
        curator = curator_;

        // Series I — the twelve relics of the testnet, same order, same art.
        string memory ar = "https://arweave.net/";
        _add("The Litecoin Revelation",  string.concat(ar, "h1I5MVU7UNMBBm5DXB8jS6jiNIUWVzI1V3AyzBHQCKY"), 0, 1);
        _add("My First Coin",            string.concat(ar, "qElCU7XNLHwFOqFl9epPG9FZXDcBPFeiVZren3s40ok"), 0, 1);
        _add("The Voyage Begins",        string.concat(ar, "ylNeH5oLBfb5z4be4H1L3xjCUH8c6S6ydbt0CE-tYx0"), 1, 1);
        _add("Spreading the Word",       string.concat(ar, "Y-L7rBKz_TcEFS8hIvtPXiYepToZb6C945iCERYW_7Y"), 0, 2);
        _add("Don't be afraid of FUD",   string.concat(ar, "xnikO7f8_KVt1cgNgkIn-u7RV1CiOJSASmF5doqpWMs"), 1, 2);
        _add("Strengthening the Chain",  string.concat(ar, "NaXLY6FgpL1uGBJXrMfbYgT0HTKW5LRjmeXYHfjL7R8"), 2, 2);
        _add("Kill the FUD!",            string.concat(ar, "ijg0tXZbynL04ANCVy12hfFqFSPg0ziT6pU_Ne62oAU"), 0, 3);
        _add("Guardian Ascended",        string.concat(ar, "Jj7EFW_G9zwwD3RMMhMb_fsWM5fWh4v8kmqYaYz2X7Y"), 2, 3);
        _add("MimbleWimble User",        string.concat(ar, "7dedZ6isXnVr85xW0wdq_UwOKCb62J_JwlxPbWdE6q8"), 3, 3);
        _add("Sanctuary Glimpse",        string.concat(ar, "7gxV59_DIo4KTCmhK0TTXzKIY6ocvii6kBkri4f_xDc"), 0, 4);
        _add("Lightning Adept",          string.concat(ar, "GCf13cwQE2VZuGB51U4XWReiME8p0TDMedWEJ1ewzKo"), 3, 4);
        _add("The Silver Throne",        string.concat(ar, "ESM4uD3tUCR9om88PU93gx4SRRCQZ7dAoLwcHXgjDVU"), 4, 4);
    }

    // ═══════════════════════════════════════════
    // CURATION — add only, never edit, never remove
    // ═══════════════════════════════════════════

    modifier onlyCurator() {
        if (curator == address(0)) revert CurationClosed();
        if (msg.sender != curator) revert NotCurator();
        _;
    }

    /**
     * @notice Add a relic to the catalogue. It enters the draw pools of every
     *         player with the required rank from the next block on, and the
     *         forge can produce it. It can never be modified or removed.
     * @param relicName Display name. Letters, digits and simple punctuation;
     *                  no double quote or backslash (it goes into JSON).
     * @param image     Full image URI, e.g. https://arweave.net/<id>.
     * @param rarity    0 Common · 1 Uncommon · 2 Rare · 3 Epic · 4 Legendary
     * @param rank      1..4, rank required to draw it.
     */
    function addRelic(string calldata relicName, string calldata image, uint8 rarity, uint8 rank)
        external onlyCurator returns (uint16 itemId)
    {
        return _add(relicName, image, rarity, rank);
    }

    function _add(string memory relicName, string memory image, uint8 rarity, uint8 rank) private returns (uint16 itemId) {
        if (_catalogue.length >= MAX_ITEMS) revert CatalogueFull();
        if (rarity > 4 || rank < 1 || rank > 4) revert BadRelic();
        if (!_safeText(relicName) || !_safeText(image)) revert BadRelic();
        _catalogue.push(Relic(relicName, image, rarity, rank));
        itemId = uint16(_catalogue.length);
        emit RelicAdded(itemId, relicName, rarity, rank, image);
    }

    /// @dev Non-empty, at most 200 bytes, no character that would break the
    ///      JSON metadata (double quote, backslash, control characters).
    function _safeText(string memory s) private pure returns (bool) {
        bytes memory b = bytes(s);
        if (b.length == 0 || b.length > 200) return false;
        for (uint256 i = 0; i < b.length; i++) {
            bytes1 c = b[i];
            if (c == '"' || c == "\\" || uint8(c) < 0x20) return false;
        }
        return true;
    }

    /**
     * @notice Correct the name and image of a relic that nobody owns yet.
     *         Refused as soon as a single copy has ever been minted: from then
     *         on the relic is frozen forever. Rarity and rank cannot change.
     */
    function correctRelic(uint16 itemId, string calldata relicName, string calldata image) external onlyCurator {
        if (itemId == 0 || itemId > _catalogue.length) revert BadItem();
        if (mintedPerItem[itemId] != 0) revert RelicFrozen();
        if (!_safeText(relicName) || !_safeText(image)) revert BadRelic();
        Relic storage r = _catalogue[itemId - 1];
        r.name = relicName;
        r.image = image;
        emit RelicCorrected(itemId, relicName, image);
    }

    /// @notice True while a relic can still be corrected (no copy ever minted).
    function isCorrectable(uint16 itemId) external view returns (bool) {
        return itemId != 0 && itemId <= _catalogue.length && mintedPerItem[itemId] == 0;
    }

    /// @notice Hand curation over (e.g. to a multisig). The new address must accept.
    function transferCuration(address to) external onlyCurator {
        if (to == address(0)) revert ZeroAddress();
        pendingCurator = to;
        emit CurationTransferStarted(curator, to);
    }

    function acceptCuration() external {
        if (curator == address(0)) revert CurationClosed();
        if (msg.sender != pendingCurator) revert NotPendingCurator();
        emit CurationTransferred(curator, msg.sender);
        curator = msg.sender;
        pendingCurator = address(0);
    }

    /// @notice Close the catalogue forever. Nobody, ever, can add a relic after this.
    function renounceCuration() external onlyCurator {
        emit CurationRenounced(msg.sender);
        curator = address(0);
        pendingCurator = address(0);
    }

    // ═══════════════════════════════════════════
    // CATALOGUE READS
    // ═══════════════════════════════════════════

    function itemCount() public view returns (uint16) { return uint16(_catalogue.length); }

    function relicInfo(uint16 id) public view returns (string memory relicName, string memory image, uint8 rarity, uint8 rank) {
        if (id == 0 || id > _catalogue.length) revert BadItem();
        Relic storage r = _catalogue[id - 1];
        return (r.name, r.image, r.rarity, r.rank);
    }

    function itemRarity(uint16 id) public view returns (uint8) {
        if (id == 0 || id > _catalogue.length) revert BadItem();
        return _catalogue[id - 1].rarity;
    }

    function itemRank(uint16 id) public view returns (uint8) {
        if (id == 0 || id > _catalogue.length) revert BadItem();
        return _catalogue[id - 1].rank;
    }

    function forgeFeeFor(uint8 targetRarity) public view returns (uint256) {
        if (targetRarity == 1) return FEE_TO_UNCOMMON;
        if (targetRarity == 2) return FEE_TO_RARE;
        if (targetRarity == 3) return FEE_TO_EPIC;
        if (targetRarity == 4) return FEE_TO_LEGENDARY;
        revert TopTier();
    }

    // ═══════════════════════════════════════════
    // ELIGIBILITY
    // ═══════════════════════════════════════════

    function burnRankOf(address player) public view returns (uint8) {
        try RITUAL.getRank(player) returns (uint8 r) { return r; } catch { return 0; }
    }

    function duelsOf(address player) public view returns (uint256) {
        try ARENA.duelCountOf(player) returns (uint256 n) { return n; } catch { return 0; }
    }

    function drawsEarned(address player) public view returns (uint256) { return duelsOf(player) / DUELS_PER_DRAW; }

    function drawsAvailable(address player) public view returns (uint256) {
        uint256 earned = drawsEarned(player);
        uint256 used = drawsUsed[player];
        return earned > used ? earned - used : 0;
    }

    function poolOf(address player) public view returns (uint16[] memory ids) {
        uint8 rank = burnRankOf(player);
        uint256 total = _catalogue.length;
        uint256 n = 0;
        for (uint256 i = 0; i < total; i++) if (_catalogue[i].rank <= rank) n++;
        ids = new uint16[](n);
        uint256 k = 0;
        for (uint256 i = 0; i < total; i++) if (_catalogue[i].rank <= rank) ids[k++] = uint16(i + 1);
    }

    // ═══════════════════════════════════════════
    // DRAW — COMMIT / REVEAL
    // ═══════════════════════════════════════════

    function commitDraw() external {
        if (burnRankOf(msg.sender) < 1) revert NoRank();
        if (drawsAvailable(msg.sender) == 0) revert NoDraws();
        if (commitOf[msg.sender].pending) revert RevealFirst();

        drawsUsed[msg.sender] += 1;
        commitOf[msg.sender] = Commit(uint64(block.number), uint64(totalPulls), true);
        emit DrawCommitted(msg.sender, block.number + SEED_OFFSET, block.number + SEED_OFFSET + REVEAL_WINDOW);
    }

    function canReveal(address player) external view returns (bool) {
        Commit memory c = commitOf[player];
        if (!c.pending) return false;
        uint256 seedBlock = uint256(c.blockNumber) + SEED_OFFSET;
        return block.number > seedBlock && block.number <= seedBlock + REVEAL_WINDOW;
    }

    function blocksLeft(address player) external view returns (uint256) {
        Commit memory c = commitOf[player];
        if (!c.pending) return 0;
        uint256 deadline = uint256(c.blockNumber) + SEED_OFFSET + REVEAL_WINDOW;
        return block.number >= deadline ? 0 : deadline - block.number;
    }

    function revealDraw() external returns (uint256 tokenId) {
        Commit memory c = commitOf[msg.sender];
        if (!c.pending) revert NoDraw();
        uint256 seedBlock = uint256(c.blockNumber) + SEED_OFFSET;
        if (block.number <= seedBlock) revert TooEarly();
        if (block.number > seedBlock + REVEAL_WINDOW) revert WindowClosed();
        bytes32 bh = blockhash(seedBlock);
        if (bh == bytes32(0)) revert NoSeed();

        delete commitOf[msg.sender];

        uint256 seed = uint256(keccak256(abi.encodePacked(bh, msg.sender, c.pullsAtCommit)));
        uint16 itemType = _roll(msg.sender, seed);
        uint8 rarity = _catalogue[itemType - 1].rarity;

        if (rarity >= 2) pityCounter[msg.sender] = 0;
        else if (_poolHasRarePlus(msg.sender)) pityCounter[msg.sender] += 1;

        tokenId = _mint(msg.sender, itemType);
        totalPulls++;
        emit RelicPulled(msg.sender, itemType, rarity, tokenId);
    }

    function clearExpiredCommit() external {
        Commit memory c = commitOf[msg.sender];
        if (!c.pending) revert NothingPending();
        if (block.number <= uint256(c.blockNumber) + SEED_OFFSET + REVEAL_WINDOW) revert StillOpen();
        delete commitOf[msg.sender];
        emit DrawAbandoned(msg.sender);
    }

    // ═══════════════════════════════════════════
    // THE FORGE
    // ═══════════════════════════════════════════

    /**
     * @notice Destroy three relics of one rarity, mint one of the rarity above.
     *         Pay forgeFeeFor(target): 95% burned for you through the Ritual,
     *         5% to the creator. Not rank-gated: the forge rewards what you
     *         collected, the draw rewards what you burned.
     */
    function forge(uint256[] calldata tokenIds) external payable returns (uint256 tokenId) {
        if (tokenIds.length != FORGE_INPUT) revert BadCount();
        if (_owners[tokenIds[0]] == address(0)) revert NoToken();

        uint8 rarity = _catalogue[tokenItem[tokenIds[0]] - 1].rarity;
        if (rarity >= 4) revert TopTier();
        uint8 target = rarity + 1;
        uint256 fee = forgeFeeFor(target);
        if (msg.value != fee) revert BadFee(msg.value, fee);

        for (uint256 i = 0; i < FORGE_INPUT; i++) {
            uint256 id = tokenIds[i];
            if (_owners[id] != msg.sender) revert NotYours();
            for (uint256 j = 0; j < i; j++) if (tokenIds[j] == id) revert DuplicateId();
            if (_catalogue[tokenItem[id] - 1].rarity != rarity) revert MixedTiers();
        }

        for (uint256 i = 0; i < FORGE_INPUT; i++) {
            uint256 id = tokenIds[i];
            uint16 it = tokenItem[id];
            delete _tokenApprovals[id];
            _owners[id] = address(0);
            _balances[msg.sender]--;
            ownedOf[msg.sender][it]--;
            burnedPerItem[it]++;
            emit Transfer(msg.sender, address(0), id);
        }
        totalForged += FORGE_INPUT;

        uint256 seed = uint256(keccak256(abi.encodePacked(blockhash(block.number - 1), msg.sender, totalPulls, totalForged, tokenIds)));
        uint16 itemType = _pickInRarity(target, seed);
        tokenId = _mint(msg.sender, itemType);

        if (target >= 2) pityCounter[msg.sender] = 0;

        // Fee: 95% burned for the forger (lifts their rank), 5% to the creator.
        if (fee > 0) {
            uint256 burnPart = (fee * FORGE_BURN_BPS) / 10000;
            uint256 creatorPart = fee - burnPart;
            totalBurnedWei += burnPart;
            if (burnPart >= RITUAL.MIN_BURN()) {
                RITUAL.burnFor{value: burnPart}(msg.sender, SOURCE_FORGE);
            } else if (burnPart > 0) {
                (bool sent, ) = DEAD_ADDRESS.call{value: burnPart}("");
                if (!sent) _payOrDefer(CREATOR, burnPart);
            }
            _payOrDefer(CREATOR, creatorPart);
        }

        emit RelicsForged(msg.sender, rarity, target, tokenIds, tokenId, fee);
    }

    /// @dev Uniform among ALL relics of that rarity — no rank filter.
    function _pickInRarity(uint8 rarity, uint256 seed) private view returns (uint16) {
        uint256 total = _catalogue.length;
        uint256 count = 0;
        for (uint256 i = 0; i < total; i++) if (_catalogue[i].rarity == rarity) count++;
        if (count == 0) revert EmptyTier();
        uint256 pick = seed % count;
        uint256 seen = 0;
        for (uint256 i = 0; i < total; i++) {
            if (_catalogue[i].rarity == rarity) {
                if (seen == pick) return uint16(i + 1);
                seen++;
            }
        }
        revert EmptyTier();
    }

    function forgeableOf(address player) external view returns (uint256[4] memory possible) {
        uint256 total = _catalogue.length;
        for (uint8 r = 0; r < 4; r++) {
            uint256 owned = 0;
            for (uint256 i = 0; i < total; i++) if (_catalogue[i].rarity == r) owned += ownedOf[player][uint16(i + 1)];
            possible[r] = owned / FORGE_INPUT;
        }
    }

    // ═══════════════════════════════════════════
    // ROLL
    // ═══════════════════════════════════════════

    function _poolHasRarePlus(address player) private view returns (bool) {
        uint8 rank = burnRankOf(player);
        uint256 total = _catalogue.length;
        for (uint256 i = 0; i < total; i++) if (_catalogue[i].rank <= rank && _catalogue[i].rarity >= 2) return true;
        return false;
    }

    function _roll(address player, uint256 seed) private view returns (uint16) {
        uint8 rank = burnRankOf(player);
        uint256 total = _catalogue.length;
        bool pityActive = pityCounter[player] >= PITY_THRESHOLD && _poolHasRarePlus(player);

        bool[5] memory present;
        for (uint256 i = 0; i < total; i++) if (_catalogue[i].rank <= rank) present[_catalogue[i].rarity] = true;
        if (pityActive) { present[0] = false; present[1] = false; }

        uint256 sum = 0;
        for (uint8 r = 0; r < 5; r++) if (present[r]) sum += RARITY_BP[r];
        if (sum == 0) revert EmptyTier();

        uint256 pick = seed % sum;
        uint8 chosen = 0;
        uint256 acc = 0;
        for (uint8 r = 0; r < 5; r++) {
            if (!present[r]) continue;
            acc += RARITY_BP[r];
            if (pick < acc) { chosen = r; break; }
        }

        uint256 count = 0;
        for (uint256 i = 0; i < total; i++) if (_catalogue[i].rank <= rank && _catalogue[i].rarity == chosen) count++;
        uint256 idx = (seed >> 128) % count;
        uint256 seen = 0;
        for (uint256 i = 0; i < total; i++) {
            if (_catalogue[i].rank <= rank && _catalogue[i].rarity == chosen) {
                if (seen == idx) return uint16(i + 1);
                seen++;
            }
        }
        revert EmptyTier();
    }

    // ═══════════════════════════════════════════
    // MINT · PAYMENTS
    // ═══════════════════════════════════════════

    function _mint(address to, uint16 itemType) private returns (uint256 tokenId) {
        tokenId = _nextTokenId++;
        _owners[tokenId] = to;
        _balances[to]++;
        tokenItem[tokenId] = itemType;
        tokenMintedAt[tokenId] = block.timestamp;
        mintedPerItem[itemType]++;
        ownedOf[to][itemType]++;
        emit Transfer(address(0), to, tokenId);
    }

    function _payOrDefer(address recipient, uint256 amount) private {
        if (amount == 0) return;
        (bool sent, ) = recipient.call{value: amount, gas: 30000}("");
        if (!sent) {
            pendingWithdrawals[recipient] += amount;
            emit PaymentDeferred(recipient, amount);
        }
    }

    function withdraw() external {
        uint256 amount = pendingWithdrawals[msg.sender];
        if (amount == 0) revert NothingToWithdraw();
        pendingWithdrawals[msg.sender] = 0;
        (bool sent, ) = msg.sender.call{value: amount}("");
        if (!sent) revert WithdrawFailed();
        emit Withdrawn(msg.sender, amount);
    }

    // ═══════════════════════════════════════════
    // READ HELPERS
    // ═══════════════════════════════════════════

    /// @notice Copies held of each item, index 0 = item 1. Length grows with
    ///         the catalogue (12 at launch).
    function inventoryOf(address player) external view returns (uint256[] memory counts) {
        uint256 total = _catalogue.length;
        counts = new uint256[](total);
        for (uint256 i = 0; i < total; i++) counts[i] = ownedOf[player][uint16(i + 1)];
    }

    function circulatingOf(uint16 id) external view returns (uint256) { return mintedPerItem[id] - burnedPerItem[id]; }

    function tokensOfOwner(address player, uint256 cursor, uint256 count) external view returns (uint256[] memory ids, uint256 nextCursor) {
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

    function totalSupply() external view returns (uint256) { return _nextTokenId - 1 - totalForged; }

    // ═══════════════════════════════════════════
    // METADATA
    // ═══════════════════════════════════════════

    function tokenURI(uint256 tokenId) external view returns (string memory) {
        if (_owners[tokenId] == address(0)) revert NoToken();
        uint16 id = tokenItem[tokenId];
        Relic storage r = _catalogue[id - 1];
        string memory json = string.concat(
            '{"name":"', r.name,
            '","description":"A relic of The Silver Void, drawn from the Void.","image":"', r.image,
            '","attributes":[{"trait_type":"Item","value":', uint256(id).toString(),
            '},{"trait_type":"Rarity","value":"', _rarityName(r.rarity),
            '"},{"trait_type":"Rank Required","value":', uint256(r.rank).toString(),
            '},{"trait_type":"Copies Minted","value":', mintedPerItem[id].toString(),
            '},{"trait_type":"Network","value":"LitVM"}]}'
        );
        return string.concat("data:application/json;base64,", Base64.encode(bytes(json)));
    }

    function contractURI() external pure returns (string memory) {
        string memory json = '{"name":"The Silver Void - Relics","description":"Relics of The Silver Void. Your rank decides which can drop; duels decide when. Duplicates can be forged upward.","external_link":"https://thesilvervoid.com"}';
        return string.concat("data:application/json;base64,", Base64.encode(bytes(json)));
    }

    function _rarityName(uint8 r) private pure returns (string memory) {
        if (r == 4) return "Legendary";
        if (r == 3) return "Epic";
        if (r == 2) return "Rare";
        if (r == 1) return "Uncommon";
        return "Common";
    }

    // ═══════════════════════════════════════════
    // ERC-721
    // ═══════════════════════════════════════════

    function balanceOf(address owner) external view returns (uint256) {
        if (owner == address(0)) revert ZeroAddress();
        return _balances[owner];
    }

    function ownerOf(uint256 tokenId) external view returns (address) {
        address owner = _owners[tokenId];
        if (owner == address(0)) revert NoToken();
        return owner;
    }

    function approve(address to, uint256 tokenId) external {
        address owner = _owners[tokenId];
        if (msg.sender != owner && !_operatorApprovals[owner][msg.sender]) revert NotAuthorized();
        _tokenApprovals[tokenId] = to;
        emit Approval(owner, to, tokenId);
    }

    function getApproved(uint256 tokenId) external view returns (address) { return _tokenApprovals[tokenId]; }

    function setApprovalForAll(address operator, bool approved) external {
        _operatorApprovals[msg.sender][operator] = approved;
        emit ApprovalForAll(msg.sender, operator, approved);
    }

    function isApprovedForAll(address owner, address operator) external view returns (bool) { return _operatorApprovals[owner][operator]; }

    function transferFrom(address from, address to, uint256 tokenId) public {
        if (to == address(0)) revert ZeroAddress();
        address owner = _owners[tokenId];
        if (owner != from) revert NotOwner();
        if (msg.sender != owner && _tokenApprovals[tokenId] != msg.sender && !_operatorApprovals[owner][msg.sender]) revert NotAuthorized();
        _balances[from]--;
        _balances[to]++;
        _owners[tokenId] = to;
        uint16 it = tokenItem[tokenId];
        ownedOf[from][it]--;
        ownedOf[to][it]++;
        delete _tokenApprovals[tokenId];
        emit Transfer(from, to, tokenId);
    }

    function safeTransferFrom(address from, address to, uint256 tokenId) external { transferFrom(from, to, tokenId); }
    function safeTransferFrom(address from, address to, uint256 tokenId, bytes calldata) external { transferFrom(from, to, tokenId); }

    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == 0x80ac58cd || interfaceId == 0x5b5e139f || interfaceId == 0x01ffc9a7;
    }
}

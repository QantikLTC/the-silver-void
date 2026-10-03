// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title SilverVoidRitual
 * @notice The Ritual of The Silver Void — mainnet revision.
 *
 *         100% of every offering is destroyed at the dead address.
 *         No owner. No fees. No upgradability. Nothing is kept.
 *
 * ═══ WHAT STAYS FROM THE TESTNET CONTRACT ═══
 *
 * The heart does not change: every wei sent is burned, the contract holds
 * nothing, nobody administers it, and a wallet's rank is read from its
 * lifetime total. `burn()`, `getRank()`, `getBurnerInfo()` and `getStats()`
 * keep their testnet signatures, so the other contracts and the site read it
 * exactly as before.
 *
 * ═══ WHAT CHANGES, AND WHY ═══
 *
 * 1. burnFor(beneficiary, source)
 *    On testnet a burn always credited msg.sender. The Store, the Arena and the
 *    Forge send their share to the dead address themselves, so those burns
 *    counted for nobody's rank. They now call burnFor(), naming the player the
 *    burn belongs to. It is open to anyone: crediting someone else costs real
 *    zkLTC destroyed forever, so it cheats no one — and keeping it open means
 *    there is no list to maintain, and therefore no one holding that list.
 *
 * 2. Rank thresholds are set at deployment.
 *    Testnet values (0.5 / 5 / 20 / 100) meant nothing without a price; on
 *    mainnet they are real LTC. They are passed to the constructor, checked,
 *    and frozen. Other contracts must read ranks through getRank() rather
 *    than copying the thresholds, so the ladder exists in one place only.
 *
 * 3. A minimum offering.
 *    On testnet, one wei entered a wallet into the burner list. On mainnet a
 *    minimum stops anyone from flooding the list with dust wallets and
 *    inflating the Sacrifiant count.
 *
 * 4. getTopBurners() is gone.
 *    It sorted every burner on each call — quadratic cost, already past what a
 *    node will execute at ~1,900 burners. Replaced by a paginated read; the
 *    sorting belongs to the server that builds the leaderboard.
 *
 * 5. The Burned event names the payer, the beneficiary and the source.
 *    Statistics per origin (Ritual, Store, Arena, Forge, Skins) can be built
 *    from events alone, without storing anything more on-chain.
 *
 * 6. One community total.
 *    Once every burn in the project flows through here, totalBurned IS the
 *    community total. The Chronicles path reads a single number.
 */
contract SilverVoidRitual {

    // ═══════════════════════════════════════════
    // CONSTANTS
    // ═══════════════════════════════════════════

    /// @notice Every offering ends here. Nobody holds this key.
    address public constant DEAD_ADDRESS = 0x000000000000000000000000000000000000dEaD;

    /// @notice Where a burn comes from. Informational only: it changes nothing
    ///         to the burn itself, and any value is accepted so that a future
    ///         contract can use its own tag without redeploying this one.
    uint8 public constant SOURCE_RITUAL = 0;
    uint8 public constant SOURCE_STORE  = 1;
    uint8 public constant SOURCE_ARENA  = 2;
    uint8 public constant SOURCE_FORGE  = 3;
    uint8 public constant SOURCE_SKIN   = 4;

    uint256 public constant PAGE_MAX = 200;

    // ═══════════════════════════════════════════
    // IMMUTABLE CONFIGURATION (set once, at deployment)
    // ═══════════════════════════════════════════

    uint256 public immutable RANK_1;
    uint256 public immutable RANK_2;
    uint256 public immutable RANK_3;
    uint256 public immutable RANK_4;

    /// @notice Smallest accepted offering, in wei.
    uint256 public immutable MIN_BURN;

    // ═══════════════════════════════════════════
    // STATE
    // ═══════════════════════════════════════════

    uint256 public totalBurned;
    uint256 public totalBurns;
    uint256 public totalBurners;

    /// @notice Lifetime amount credited to each wallet (burned by it or for it).
    mapping(address => uint256) public burnedAmount;

    mapping(address => bool) private _hasBurned;
    address[] private _burnerList;

    // ═══════════════════════════════════════════
    // EVENTS & ERRORS
    // ═══════════════════════════════════════════

    event Burned(
        address indexed payer,
        address indexed beneficiary,
        uint8   indexed source,
        uint256 amount,
        uint256 newBeneficiaryTotal,
        uint256 globalTotal,
        uint256 timestamp
    );

    event RankUp(address indexed burner, uint8 newRank, string rankName);

    error BelowMinimum(uint256 sent, uint256 minimum);
    error InvalidBeneficiary();
    error BurnFailed();
    error UseBurnFunction();
    error BadThresholds();

    // ═══════════════════════════════════════════
    // CONSTRUCTOR
    // ═══════════════════════════════════════════

    /**
     * @param thresholds Lifetime amounts for ranks 1..4, in wei, strictly
     *                   increasing. Example for 0.5 / 2.5 / 10 / 30:
     *                   [0.5e18, 2.5e18, 10e18, 30e18].
     * @param minBurn    Smallest accepted offering, in wei. Must be greater
     *                   than zero and not above the rank-1 threshold.
     */
    constructor(uint256[4] memory thresholds, uint256 minBurn) {
        if (
            minBurn == 0 ||
            minBurn > thresholds[0] ||
            thresholds[0] >= thresholds[1] ||
            thresholds[1] >= thresholds[2] ||
            thresholds[2] >= thresholds[3]
        ) revert BadThresholds();

        RANK_1 = thresholds[0];
        RANK_2 = thresholds[1];
        RANK_3 = thresholds[2];
        RANK_4 = thresholds[3];
        MIN_BURN = minBurn;
    }

    // ═══════════════════════════════════════════
    // BURN
    // ═══════════════════════════════════════════

    /// @notice Pour zkLTC into the Void. Credits your own rank.
    function burn() external payable {
        _burn(msg.sender, msg.sender, SOURCE_RITUAL);
    }

    /**
     * @notice Burn on behalf of another wallet, which receives the credit.
     *         Used by the Store, the Arena and the Forge so that their burns
     *         count for the player who paid them. Open to anyone.
     * @param beneficiary Wallet credited with the burn.
     * @param source      Where the burn comes from (see SOURCE_*). Informational.
     */
    function burnFor(address beneficiary, uint8 source) external payable {
        _burn(msg.sender, beneficiary, source);
    }

    function _burn(address payer, address beneficiary, uint8 source) private {
        if (msg.value < MIN_BURN) revert BelowMinimum(msg.value, MIN_BURN);
        if (beneficiary == address(0) || beneficiary == DEAD_ADDRESS) revert InvalidBeneficiary();

        uint8 rankBefore = getRank(beneficiary);

        if (!_hasBurned[beneficiary]) {
            _hasBurned[beneficiary] = true;
            _burnerList.push(beneficiary);
            totalBurners++;
        }

        uint256 newTotal = burnedAmount[beneficiary] + msg.value;
        burnedAmount[beneficiary] = newTotal;
        totalBurned += msg.value;
        totalBurns++;

        // Effects are done; the only interaction is the burn itself. The dead
        // address has no code, so this cannot re-enter.
        (bool sent, ) = DEAD_ADDRESS.call{value: msg.value}("");
        if (!sent) revert BurnFailed();

        emit Burned(payer, beneficiary, source, msg.value, newTotal, totalBurned, block.timestamp);

        uint8 rankAfter = getRank(beneficiary);
        if (rankAfter > rankBefore) emit RankUp(beneficiary, rankAfter, getRankName(rankAfter));
    }

    // ═══════════════════════════════════════════
    // RANKS
    // ═══════════════════════════════════════════

    /// @notice Rank of a wallet: 0 = no rank, 1..4. The single source of truth
    ///         for every other contract of the project.
    function getRank(address user) public view returns (uint8) {
        uint256 amount = burnedAmount[user];
        if (amount >= RANK_4) return 4;
        if (amount >= RANK_3) return 3;
        if (amount >= RANK_2) return 2;
        if (amount >= RANK_1) return 1;
        return 0;
    }

    function getRankName(uint8 rank) public pure returns (string memory) {
        if (rank == 4) return "Silver Maximalist";
        if (rank == 3) return "Devoted Litecoiner";
        if (rank == 2) return "Apprentice Litecoiner";
        if (rank == 1) return "Simple Holder";
        return "The Void";
    }

    /// @notice The four thresholds, so the site can display the ladder
    ///         without hard-coding it.
    function rankThresholds() external view returns (uint256[4] memory) {
        return [RANK_1, RANK_2, RANK_3, RANK_4];
    }

    /// @notice Same signature as the testnet contract.
    function getBurnerInfo(address user) external view returns (
        uint256 amount,
        uint8   rank,
        string memory rankName
    ) {
        amount   = burnedAmount[user];
        rank     = getRank(user);
        rankName = getRankName(rank);
    }

    // ═══════════════════════════════════════════
    // READS
    // ═══════════════════════════════════════════

    /// @notice Same signature as the testnet contract.
    function getStats() external view returns (
        uint256 _totalBurned,
        uint256 _totalBurners,
        uint256 _totalBurns
    ) {
        return (totalBurned, totalBurners, totalBurns);
    }

    function getBurnerCount() external view returns (uint256) {
        return _burnerList.length;
    }

    function burnerAt(uint256 index) external view returns (address) {
        return _burnerList[index];
    }

    /**
     * @notice A page of burners with their lifetime totals, in first-burn
     *         order. Replaces getTopBurners(): sorting is the server's job.
     * @param cursor Index to start from (0 for the first page).
     * @param count  Max entries to return (capped at PAGE_MAX).
     * @return addresses  Burner addresses.
     * @return amounts    Their lifetime totals, same order.
     * @return nextCursor Index to pass for the next page; 0 when finished.
     */
    function burnersPage(uint256 cursor, uint256 count)
        external view
        returns (address[] memory addresses, uint256[] memory amounts, uint256 nextCursor)
    {
        uint256 len = _burnerList.length;
        if (count > PAGE_MAX) count = PAGE_MAX;
        if (cursor >= len) return (new address[](0), new uint256[](0), 0);

        uint256 n = len - cursor;
        if (n > count) n = count;

        addresses = new address[](n);
        amounts = new uint256[](n);
        for (uint256 i = 0; i < n; i++) {
            address a = _burnerList[cursor + i];
            addresses[i] = a;
            amounts[i] = burnedAmount[a];
        }
        nextCursor = (cursor + n < len) ? cursor + n : 0;
    }

    // ═══════════════════════════════════════════
    // SAFETY
    // ═══════════════════════════════════════════

    receive() external payable { revert UseBurnFunction(); }
    fallback() external payable { revert UseBurnFunction(); }
}

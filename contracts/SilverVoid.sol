// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title SilverVoid
 * @notice The first Decentralized Pensieve on LitVM — LiteForge Testnet
 * @dev Voluntary burn protocol. 100% of zkLTC sent is destroyed to 0x000...dEaD.
 *      No owner. No fees. No upgradability. Fully trustless and immutable.
 */
contract SilverVoid {

    // ═══════════════════════════════════════════
    // CONSTANTS
    // ═══════════════════════════════════════════

    /// @notice The dead address — all burned zkLTC goes here forever
    address public constant DEAD_ADDRESS = 0x000000000000000000000000000000000000dEaD;

    /// @notice Rank thresholds in wei (1 zkLTC = 1e18 wei)
    uint256 public constant RANK_1 =   0.5 ether;   // Simple Holder
    uint256 public constant RANK_2 =   5   ether;   // Apprentice Litecoiner
    uint256 public constant RANK_3 =  20   ether;   // Devoted Litecoiner
    uint256 public constant RANK_4 = 100   ether;   // Silver Maximalist

    // ═══════════════════════════════════════════
    // STATE
    // ═══════════════════════════════════════════

    /// @notice Total zkLTC destroyed across all burners
    uint256 public totalBurned;

    /// @notice Total number of individual burn transactions
    uint256 public totalBurns;

    /// @notice Total unique wallets that have burned
    uint256 public totalBurners;

    /// @notice Amount burned per wallet
    mapping(address => uint256) public burnedAmount;

    /// @notice Whether a wallet has burned before (for unique count)
    mapping(address => bool) private hasBurned;

    /// @notice Ordered list of all unique burner addresses (for leaderboard)
    address[] private burnerList;

    // ═══════════════════════════════════════════
    // EVENTS
    // ═══════════════════════════════════════════

    event Burned(
        address indexed burner,
        uint256 amount,
        uint256 newBurnerTotal,
        uint256 globalTotal,
        uint256 timestamp
    );

    event RankUp(
        address indexed burner,
        uint8 newRank,
        string rankName
    );

    // ═══════════════════════════════════════════
    // MAIN FUNCTION
    // ═══════════════════════════════════════════

    /**
     * @notice Pour your zkLTC into the Silver Void.
     *         100% is sent to the dead address. Nothing is kept.
     */
    function burn() external payable {
        require(msg.value > 0, "SilverVoid: amount must be greater than 0");

        uint8 rankBefore = getRank(msg.sender);

        if (!hasBurned[msg.sender]) {
            hasBurned[msg.sender] = true;
            burnerList.push(msg.sender);
            totalBurners++;
        }

        burnedAmount[msg.sender] += msg.value;
        totalBurned += msg.value;
        totalBurns++;

        (bool sent, ) = DEAD_ADDRESS.call{value: msg.value}("");
        require(sent, "SilverVoid: transfer to dead address failed");

        emit Burned(
            msg.sender,
            msg.value,
            burnedAmount[msg.sender],
            totalBurned,
            block.timestamp
        );

        uint8 rankAfter = getRank(msg.sender);
        if (rankAfter > rankBefore) {
            emit RankUp(msg.sender, rankAfter, getRankName(rankAfter));
        }
    }

    // ═══════════════════════════════════════════
    // READ FUNCTIONS
    // ═══════════════════════════════════════════

    /**
     * @notice Get the rank of any wallet (0–4)
     * @return rank 0=No Rank, 1=Simple Holder, 2=Apprentice Litecoiner,
     *              3=Devoted Litecoiner, 4=Silver Maximalist
     */
    function getRank(address user) public view returns (uint8) {
        uint256 amount = burnedAmount[user];
        if (amount >= RANK_4) return 4;
        if (amount >= RANK_3) return 3;
        if (amount >= RANK_2) return 2;
        if (amount >= RANK_1) return 1;
        return 0;
    }

    /**
     * @notice Get the rank name as a string
     */
    function getRankName(uint8 rank) public pure returns (string memory) {
        if (rank == 4) return "Silver Maximalist";
        if (rank == 3) return "Devoted Litecoiner";
        if (rank == 2) return "Apprentice Litecoiner";
        if (rank == 1) return "Simple Holder";
        return "The Void";
    }

    /**
     * @notice Get full info for a wallet
     */
    function getBurnerInfo(address user) external view returns (
        uint256 amount,
        uint8   rank,
        string memory rankName
    ) {
        amount   = burnedAmount[user];
        rank     = getRank(user);
        rankName = getRankName(rank);
    }

    /**
     * @notice Get global protocol statistics
     */
    function getStats() external view returns (
        uint256 _totalBurned,
        uint256 _totalBurners,
        uint256 _totalBurns
    ) {
        return (totalBurned, totalBurners, totalBurns);
    }

    /**
     * @notice Get top N burners for the leaderboard (max 100)
     */
    function getTopBurners(uint256 limit) external view returns (
        address[] memory addresses,
        uint256[] memory amounts
    ) {
        uint256 count = burnerList.length;
        if (limit > 100) limit = 100;
        if (limit > count) limit = count;

        address[] memory addrs = new address[](count);
        uint256[] memory amts  = new uint256[](count);
        for (uint256 i = 0; i < count; i++) {
            addrs[i] = burnerList[i];
            amts[i]  = burnedAmount[burnerList[i]];
        }

        // Bubble sort descending
        for (uint256 i = 0; i < count; i++) {
            for (uint256 j = i + 1; j < count; j++) {
                if (amts[j] > amts[i]) {
                    (amts[i],  amts[j])  = (amts[j],  amts[i]);
                    (addrs[i], addrs[j]) = (addrs[j], addrs[i]);
                }
            }
        }

        addresses = new address[](limit);
        amounts   = new uint256[](limit);
        for (uint256 i = 0; i < limit; i++) {
            addresses[i] = addrs[i];
            amounts[i]   = amts[i];
        }
    }

    /**
     * @notice Total number of unique burners
     */
    function getBurnerCount() external view returns (uint256) {
        return burnerList.length;
    }

    // ═══════════════════════════════════════════
    // SAFETY
    // ═══════════════════════════════════════════

    receive() external payable {
        revert("SilverVoid: use the burn() function");
    }

    fallback() external payable {
        revert("SilverVoid: use the burn() function");
    }
}

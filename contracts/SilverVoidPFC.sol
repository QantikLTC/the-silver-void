// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title SilverVoidPFC
 * @notice Rock Paper Scissors PvP duels — variable stake (0.1 / 0.5 / 1 / 5 zkLTC)
 * @dev Commit-reveal. 75% winner / 5% creator / 20% burned. Tie = full refund.
 *
 * ═══ CHANGE IN THIS REVISION ═══
 *
 * REVEAL_DELAY: 6 hours → 24 hours.
 *
 * Measured on 843 testnet duels: 418 of them (≈50%) ended in a timeout claim
 * rather than a played hand, and 65% of all leaderboard wins were unplayed
 * forfeits. The top-ranked wallet had 12 real wins against 158 forfeits — and
 * a losing head-to-head record. A six-hour window is shorter than a night's
 * sleep, so players in the wrong timezone forfeited by default, not by choice.
 * Twenty-four hours covers every timezone; anyone who plays the same day keeps
 * their duel.
 *
 * Nothing else changes: the commit scheme, stake tiers, split percentages,
 * function signatures and all events are identical, so the existing frontend
 * works unmodified against this contract.
 *
 * ═══ CARRIED OVER FROM THE PREVIOUS REVISION ═══
 *
 * 1. PAGINATED GETTER — getDuelsBatch(fromId, count). One call returns up to
 *    100 duels instead of one getDuel() round-trip per id.
 *
 * 2. PLAYER INDEX — getDuelIdsOf(player, cursor, count). Each player's duel
 *    ids are recorded at create/join time, so "My Duels" reads them directly
 *    instead of scanning event logs over block ranges.
 *
 * 3. PULL PAYMENTS — payouts/refunds that fail no longer revert the whole
 *    transaction. The amount is credited to pendingWithdrawals[recipient],
 *    claimable anytime via withdraw(). Transfers use a 30k gas stipend
 *    (deliberate, anti-reentrancy), but smart-contract wallets (Safe, AA
 *    accounts) can need more than that in receive() — without this, a winner
 *    using such a wallet could never be paid.
 *
 * ═══ DEPLOYMENT NOTE ═══
 *
 * Duel ids restart at 1 on a fresh deployment. The frontend keeps reading the
 * retired contract through its LEGACY_DUEL_CONTRACTS list so leaderboard
 * history and duel-feat progress survive the migration — add the old address
 * there when you switch DUEL_CONTRACT to this one.
 */
contract SilverVoidPFC {

    address public constant DEAD_ADDRESS = 0x000000000000000000000000000000000000dEaD;
    address public constant CREATOR      = 0x5489667F306a6F03F550FCB129F765f83FaCB24E;

    uint256 public constant STAKE_LOW    = 0.1 ether;
    uint256 public constant STAKE_MID    = 0.5 ether;
    uint256 public constant STAKE_HIGH   = 1   ether;
    uint256 public constant STAKE_MAX    = 5   ether;

    /// @notice Window the creator has to reveal after an opponent joins.
    ///         Deliberately longer than a night: a player who forgets for a
    ///         few hours should not forfeit, and an opponent should not win
    ///         a duel that was never actually played.
    uint256 public constant REVEAL_DELAY = 24 hours;

    uint256 public constant WINNER_BPS   = 7500;
    uint256 public constant CREATOR_BPS  =  500;

    enum Choice { None, Rock, Paper, Scissors }
    enum DuelStatus { Open, Joined, Finished, Cancelled, Tied }

    struct Duel {
        uint256    id;
        address    playerA;
        address    playerB;
        bytes32    commitA;
        Choice     choiceA;
        Choice     choiceB;
        address    winner;
        uint256    stake;
        uint256    createdAt;
        uint256    joinedAt;
        DuelStatus status;
    }

    uint256 private _nextDuelId = 1;
    mapping(uint256 => Duel) public duels;
    uint256[] public openDuelIds;

    // ═══ Player index — duel ids per wallet, filled at create/join ═══
    mapping(address => uint256[]) private _duelsOf;

    // ═══ Pull payments ═══
    mapping(address => uint256) public pendingWithdrawals;

    uint256 public totalBurned;
    uint256 public totalDuels;
    uint256 public totalTies;

    event DuelCreated(uint256 indexed duelId, address indexed playerA, uint256 stake);
    event DuelJoined(uint256 indexed duelId, address indexed playerB, Choice choiceB);
    event DuelRevealed(uint256 indexed duelId, Choice choiceA, Choice choiceB, address winner);
    event DuelTied(uint256 indexed duelId, Choice choice);
    event DuelCancelled(uint256 indexed duelId, address indexed player);
    event BClaimedTimeout(uint256 indexed duelId, address indexed playerB);
    event PaymentDeferred(address indexed recipient, uint256 amount); // direct send failed; credited for withdraw()
    event Withdrawn(address indexed recipient, uint256 amount);

    function _validStake(uint256 amount) private pure returns (bool) {
        return amount == STAKE_LOW  ||
               amount == STAKE_MID  ||
               amount == STAKE_HIGH ||
               amount == STAKE_MAX;
    }

    function createDuel(bytes32 commitA) external payable {
        require(_validStake(msg.value), "SilverVoidPFC: stake must be 0.1, 0.5, 1 or 5 zkLTC");
        require(commitA != bytes32(0), "SilverVoidPFC: invalid commit");
        uint256 duelId = _nextDuelId++;
        duels[duelId] = Duel({
            id: duelId, playerA: msg.sender, playerB: address(0),
            commitA: commitA, choiceA: Choice.None, choiceB: Choice.None,
            winner: address(0), stake: msg.value,
            createdAt: block.timestamp, joinedAt: 0, status: DuelStatus.Open
        });
        openDuelIds.push(duelId);
        _duelsOf[msg.sender].push(duelId);
        emit DuelCreated(duelId, msg.sender, msg.value);
    }

    function joinDuel(uint256 duelId, Choice choiceB) external payable {
        Duel storage d = duels[duelId];
        require(d.status == DuelStatus.Open, "SilverVoidPFC: duel not open");
        require(msg.sender != d.playerA, "SilverVoidPFC: cannot duel yourself");
        require(msg.value == d.stake, "SilverVoidPFC: wrong stake amount");
        require(choiceB >= Choice.Rock && choiceB <= Choice.Scissors, "SilverVoidPFC: invalid choice");
        d.playerB = msg.sender;
        d.choiceB = choiceB;
        d.joinedAt = block.timestamp;
        d.status = DuelStatus.Joined;
        _removeFromOpen(duelId);
        _duelsOf[msg.sender].push(duelId);
        emit DuelJoined(duelId, msg.sender, choiceB);
    }

    function reveal(uint256 duelId, Choice choiceA, bytes32 secretA) external {
        Duel storage d = duels[duelId];
        require(d.status == DuelStatus.Joined, "SilverVoidPFC: duel not in reveal phase");
        require(msg.sender == d.playerA, "SilverVoidPFC: only player A can reveal");
        require(choiceA >= Choice.Rock && choiceA <= Choice.Scissors, "SilverVoidPFC: invalid choice");
        require(keccak256(abi.encodePacked(uint8(choiceA), secretA)) == d.commitA, "SilverVoidPFC: commit mismatch");

        d.choiceA = choiceA;
        uint256 total = d.stake + d.stake;

        if (choiceA == d.choiceB) {
            d.status = DuelStatus.Tied;
            totalTies++;
            emit DuelTied(duelId, choiceA);
            _payOrDefer(d.playerA, d.stake);
            _payOrDefer(d.playerB, d.stake);
        } else {
            bool aWins = (
                (choiceA == Choice.Rock     && d.choiceB == Choice.Scissors) ||
                (choiceA == Choice.Paper    && d.choiceB == Choice.Rock)     ||
                (choiceA == Choice.Scissors && d.choiceB == Choice.Paper)
            );
            address winner = aWins ? d.playerA : d.playerB;
            d.winner = winner;
            d.status = DuelStatus.Finished;
            totalDuels++;
            emit DuelRevealed(duelId, choiceA, d.choiceB, winner);
            _distribute(total, winner);
        }
    }

    function claimRevealTimeout(uint256 duelId) external {
        Duel storage d = duels[duelId];
        require(d.status == DuelStatus.Joined, "SilverVoidPFC: wrong status");
        require(msg.sender == d.playerB, "SilverVoidPFC: only player B");
        require(block.timestamp >= d.joinedAt + REVEAL_DELAY, "SilverVoidPFC: too early");
        d.status = DuelStatus.Finished;
        d.winner = d.playerB;
        totalDuels++;
        emit BClaimedTimeout(duelId, d.playerB);
        _distribute(d.stake + d.stake, d.playerB);
    }

    function cancelDuel(uint256 duelId) external {
        Duel storage d = duels[duelId];
        require(d.status == DuelStatus.Open, "SilverVoidPFC: duel not open");
        require(msg.sender == d.playerA, "SilverVoidPFC: not your duel");
        // No time lock — creator may cancel anytime while still Open (no opponent yet)
        d.status = DuelStatus.Cancelled;
        _removeFromOpen(duelId);
        emit DuelCancelled(duelId, d.playerA);
        _payOrDefer(d.playerA, d.stake);
    }

    /// @notice Claim any payouts/refunds that couldn't be delivered directly
    ///         (e.g. because the recipient is a smart-contract wallet whose
    ///         receive() needs more than the 30k gas stipend).
    function withdraw() external {
        uint256 amount = pendingWithdrawals[msg.sender];
        require(amount > 0, "SilverVoidPFC: nothing to withdraw");
        pendingWithdrawals[msg.sender] = 0; // effects before interactions
        (bool sent, ) = msg.sender.call{value: amount}("");
        require(sent, "SilverVoidPFC: withdraw failed");
        emit Withdrawn(msg.sender, amount);
    }

    // ═══════════════════════════════════════════
    // READ FUNCTIONS
    // ═══════════════════════════════════════════

    function getOpenDuels() external view returns (uint256[] memory) { return openDuelIds; }
    function getDuel(uint256 id) external view returns (Duel memory) { return duels[id]; }
    function openDuelCount() external view returns (uint256) { return openDuelIds.length; }

    /// @notice Highest duel id ever created. Unlike totalDuels (which only
    ///         counts RESOLVED duels), this covers every duel including
    ///         ones still Open or Joined.
    function lastDuelId() external view returns (uint256) { return _nextDuelId - 1; }

    /// @notice Returns up to `count` duels starting at fromId, in one call.
    /// @param fromId  First duel id to include (1-based).
    /// @param count   Max duels to return (capped at 100).
    function getDuelsBatch(uint256 fromId, uint256 count) external view returns (Duel[] memory batch) {
        if (count > 100) count = 100;
        if (fromId == 0) fromId = 1;
        uint256 last = _nextDuelId; // exclusive
        if (fromId >= last) return new Duel[](0);
        uint256 n = last - fromId;
        if (n > count) n = count;
        batch = new Duel[](n);
        for (uint256 i = 0; i < n; i++) {
            batch[i] = duels[fromId + i];
        }
    }

    /// @notice Number of duels this player has ever created or joined.
    function duelCountOf(address player) external view returns (uint256) {
        return _duelsOf[player].length;
    }

    /// @notice Paginated duel ids for a player — "My Duels" reads this
    ///         directly instead of scanning event logs over block ranges.
    /// @param player  The wallet to query.
    /// @param cursor  Index into the player's duel list to start from (0-based).
    /// @param count   Max ids to return (capped at 100).
    function getDuelIdsOf(address player, uint256 cursor, uint256 count)
        external view returns (uint256[] memory ids, uint256 nextCursor)
    {
        uint256[] storage all = _duelsOf[player];
        uint256 len = all.length;
        if (count > 100) count = 100;
        if (cursor >= len) return (new uint256[](0), 0);
        uint256 n = len - cursor;
        if (n > count) n = count;
        ids = new uint256[](n);
        for (uint256 i = 0; i < n; i++) {
            ids[i] = all[cursor + i];
        }
        nextCursor = (cursor + n < len) ? cursor + n : 0;
    }

    // ═══════════════════════════════════════════
    // INTERNAL
    // ═══════════════════════════════════════════

    function _distribute(uint256 total, address winner) private {
        uint256 payout     = (total * WINNER_BPS)  / 10000;
        uint256 creatorFee = (total * CREATOR_BPS) / 10000;
        uint256 burnAmount = total - payout - creatorFee;

        _payOrDefer(winner, payout);
        _payOrDefer(CREATOR, creatorFee);

        (bool burned,) = DEAD_ADDRESS.call{value: burnAmount}("");
        if (burned) {
            totalBurned += burnAmount;
        } else {
            // Dead address has no code; this cannot legitimately fail. Kept
            // as a defensive fallback: route to CREATOR (deferred if needed)
            // rather than lock funds.
            _payOrDefer(CREATOR, burnAmount);
        }
    }

    /// @dev Attempts a direct transfer with a 30k gas stipend (deliberate,
    ///      anti-reentrancy). If it fails — typically a smart-contract
    ///      wallet needing more gas in receive() — the amount is credited
    ///      for later withdraw() instead of reverting the whole tx.
    function _payOrDefer(address recipient, uint256 amount) private {
        if (amount == 0) return;
        (bool sent, ) = recipient.call{value: amount, gas: 30000}("");
        if (!sent) {
            pendingWithdrawals[recipient] += amount;
            emit PaymentDeferred(recipient, amount);
        }
    }

    function _removeFromOpen(uint256 duelId) private {
        uint256 len = openDuelIds.length;
        for (uint256 i = 0; i < len; i++) {
            if (openDuelIds[i] == duelId) {
                openDuelIds[i] = openDuelIds[len - 1];
                openDuelIds.pop();
                break;
            }
        }
    }

    receive() external payable { revert("SilverVoidPFC: use createDuel()"); }
    fallback() external payable { revert("SilverVoidPFC: use createDuel()"); }
}

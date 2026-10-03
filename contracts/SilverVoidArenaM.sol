// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title SilverVoidArena
 * @notice Rock · Paper · Scissors duels, settled on-chain — mainnet revision.
 *
 * ═══ THE ECONOMY ═══
 *
 *   A winner is decided (reveal, or forfeit after the reveal window):
 *     80% of the pot to the winner
 *     16% burned — 8% of the pot credited to EACH player's rank
 *      4% to the creator
 *
 *   A tie (same hand):
 *     each player gets 95.5% of their own stake back
 *     3% of each stake burned, credited to that player's rank
 *     1.5% of each stake to the creator
 *
 *   A duel cancelled before anyone joined: full refund, nothing taken.
 *
 * Every burn goes through the Ritual's burnFor(), so it lifts the rank of the
 * player whose stake was burned — winner and loser alike.
 *
 * ═══ WHAT CHANGED FROM THE TESTNET CONTRACT, AND WHY ═══
 *
 * 1. NO LAST-SECOND CANCEL. Player B's hand is public the moment their join
 *    transaction is broadcast. On testnet, A could watch for a losing join and
 *    front-run it with cancelDuel(), keeping only the duels they win. A cancel
 *    is now two steps: requestCancel(), then finalizeCancel() once CANCEL_DELAY
 *    has passed. The duel stays joinable during the delay, and stops being
 *    joinable when the delay ends — so there is never a moment where A holds
 *    a cancel ready to fire at an incoming join.
 *
 * 2. NO LATE REVEAL. reveal() is refused once the reveal window has closed.
 *    On testnet, past the deadline A could reveal only if winning and stay
 *    silent otherwise, or front-run B's timeout claim with a winning reveal.
 *
 * 3. O(1) OPEN LIST. Removing a duel from the open list used to scan the whole
 *    array: a few thousand dust duels would make every join and cancel too
 *    expensive to execute. Each duel now remembers its position.
 *
 * 4. COMMIT BOUND TO THE PLAYER. The commit hashes the hand, the secret AND
 *    the creator's address, so a commit cannot be replayed by someone else.
 *
 * 5. FREE STAKES, CAPPED BY RANK. Any amount between MIN_STAKE and the cap of
 *    the player's rank (read live from the Ritual). Both players must be
 *    allowed to play that amount.
 *
 * 6. RELIC DRAWS COUNT DECIDED DUELS ONLY. duelCountOf() — read by the relic
 *    contract to grant draws — now counts duels that ended with a winner (a
 *    revealed win or a forfeit), for both players, and only from
 *    DRAW_MIN_STAKE upward. Ties burn and credit ranks, but give no draw: a
 *    player holding both wallets can arrange a tie at will, and ties are the
 *    cheapest outcome — counting them made self-duelling the cheapest road to
 *    relics, and through the forge, to the rarest ones.
 *    On testnet draws were counted at creation: create-and-cancel was a free
 *    draw, and dust duels were almost free ones.
 *
 * ═══ KEPT FROM THE TESTNET CONTRACT ═══
 *
 *   Commit-reveal, the 24h reveal window, pull payments for wallets that
 *   refuse a plain transfer, paginated reads, the per-player duel index.
 */

interface IRitual {
    function getRank(address user) external view returns (uint8);
    function burnFor(address beneficiary, uint8 source) external payable;
    function MIN_BURN() external view returns (uint256);
}

contract SilverVoidArena {

    // ═══════════════════════════════════════════
    // CONSTANTS
    // ═══════════════════════════════════════════

    address public constant DEAD_ADDRESS = 0x000000000000000000000000000000000000dEaD;
    uint8   public constant SOURCE_ARENA = 2;

    // Share of the POT when a winner is decided (basis points).
    uint256 public constant WINNER_BPS  = 8000;   // 80%
    uint256 public constant BURN_BPS    = 1600;   // 16% (8% per player)
    uint256 public constant CREATOR_BPS =  400;   //  4%

    // Share of EACH STAKE on a tie.
    uint256 public constant TIE_BURN_BPS = 300;   // 3%
    uint256 public constant TIE_FEE_BPS  = 150;   // 1.5%

    enum Choice { None, Rock, Paper, Scissors }
    enum Status { Open, Joined, Finished, Cancelled, Tied }

    struct Duel {
        uint256 id;
        address playerA;
        address playerB;
        bytes32 commitA;
        Choice  choiceA;
        Choice  choiceB;
        address winner;
        uint256 stake;
        uint64  createdAt;
        uint64  joinedAt;
        uint64  cancelRequestedAt;   // 0 = no cancel requested
        Status  status;
    }

    // ═══════════════════════════════════════════
    // IMMUTABLE CONFIGURATION (set once, at deployment)
    // ═══════════════════════════════════════════

    IRitual public immutable RITUAL;
    address public immutable CREATOR;

    uint256 public immutable MIN_STAKE;
    uint256 public immutable DRAW_MIN_STAKE;

    /// @notice Stake cap per rank: index 0 = no rank, 1..4 = ranks.
    uint256 public immutable CAP_0;
    uint256 public immutable CAP_1;
    uint256 public immutable CAP_2;
    uint256 public immutable CAP_3;
    uint256 public immutable CAP_4;

    uint256 public immutable REVEAL_DELAY;
    uint256 public immutable CANCEL_DELAY;

    // ═══════════════════════════════════════════
    // STATE
    // ═══════════════════════════════════════════

    uint256 private _nextDuelId = 1;
    mapping(uint256 => Duel) public duels;

    uint256[] private _openIds;
    mapping(uint256 => uint256) private _openPos;   // duelId => index + 1 (0 = not listed)

    mapping(address => uint256[]) private _duelsOf;
    mapping(address => uint256) private _drawDuels;

    mapping(address => uint256) public pendingWithdrawals;

    uint256 public totalBurned;
    uint256 public totalDuels;   // resolved with a winner
    uint256 public totalTies;

    // ═══════════════════════════════════════════
    // EVENTS & ERRORS
    // ═══════════════════════════════════════════

    event DuelCreated(uint256 indexed duelId, address indexed playerA, uint256 stake);
    event DuelJoined(uint256 indexed duelId, address indexed playerB, Choice choiceB);
    event DuelRevealed(uint256 indexed duelId, Choice choiceA, Choice choiceB, address winner);
    event DuelTied(uint256 indexed duelId, Choice choice);
    event CancelRequested(uint256 indexed duelId, uint256 effectiveAt);
    event DuelCancelled(uint256 indexed duelId, address indexed player);
    event BClaimedTimeout(uint256 indexed duelId, address indexed playerB);
    event PaymentDeferred(address indexed recipient, uint256 amount);
    event Withdrawn(address indexed recipient, uint256 amount);

    error BadConfig();
    error StakeOutOfRange(uint256 stake, uint256 min, uint256 max);
    error InvalidCommit();
    error InvalidChoice();
    error WrongStatus();
    error NotPlayerA();
    error NotPlayerB();
    error CannotDuelYourself();
    error WrongStake();
    error NoLongerJoinable();
    error CancelAlreadyRequested();
    error CancelNotRequested();
    error CancelNotReady();
    error CommitMismatch();
    error RevealWindowClosed();
    error TooEarly();
    error NothingToWithdraw();
    error WithdrawFailed();
    error UseCreateDuel();

    // ═══════════════════════════════════════════
    // CONSTRUCTOR
    // ═══════════════════════════════════════════

    /**
     * @param ritual        The Ritual contract (ranks and burnFor).
     * @param creator       Receives the creator share. Use a hardware wallet or
     *                      a multisig on mainnet.
     * @param minStake      Smallest stake accepted.
     * @param drawMinStake  Smallest stake that counts toward relic draws.
     * @param caps          Stake cap per rank, [no rank, 1, 2, 3, 4], each
     *                      at least minStake and never decreasing.
     * @param revealDelay   Seconds A has to reveal after B joins (24h).
     * @param cancelDelay   Seconds between requestCancel and finalizeCancel.
     */
    constructor(
        address ritual,
        address creator,
        uint256 minStake,
        uint256 drawMinStake,
        uint256[5] memory caps,
        uint256 revealDelay,
        uint256 cancelDelay
    ) {
        if (ritual == address(0) || creator == address(0) || minStake == 0) revert BadConfig();
        if (drawMinStake < minStake || revealDelay == 0 || cancelDelay == 0) revert BadConfig();
        if (caps[0] < minStake) revert BadConfig();
        for (uint256 i = 1; i < 5; i++) if (caps[i] < caps[i - 1]) revert BadConfig();

        RITUAL = IRitual(ritual);
        CREATOR = creator;
        MIN_STAKE = minStake;
        DRAW_MIN_STAKE = drawMinStake;
        CAP_0 = caps[0]; CAP_1 = caps[1]; CAP_2 = caps[2]; CAP_3 = caps[3]; CAP_4 = caps[4];
        REVEAL_DELAY = revealDelay;
        CANCEL_DELAY = cancelDelay;
    }

    // ═══════════════════════════════════════════
    // STAKE LIMITS
    // ═══════════════════════════════════════════

    function capForRank(uint8 rank) public view returns (uint256) {
        if (rank >= 4) return CAP_4;
        if (rank == 3) return CAP_3;
        if (rank == 2) return CAP_2;
        if (rank == 1) return CAP_1;
        return CAP_0;
    }

    /// @notice Largest stake this wallet may play today.
    function maxStakeOf(address player) public view returns (uint256) {
        return capForRank(RITUAL.getRank(player));
    }

    function _checkStake(address player, uint256 stake) private view {
        uint256 max = maxStakeOf(player);
        if (stake < MIN_STAKE || stake > max) revert StakeOutOfRange(stake, MIN_STAKE, max);
    }

    /// @notice The commit a player must send: binds hand, secret and address.
    function commitOf(uint8 choice, bytes32 secret, address player) public pure returns (bytes32) {
        return keccak256(abi.encodePacked(choice, secret, player));
    }

    // ═══════════════════════════════════════════
    // CREATE · JOIN
    // ═══════════════════════════════════════════

    function createDuel(bytes32 commitA) external payable returns (uint256 duelId) {
        if (commitA == bytes32(0)) revert InvalidCommit();
        _checkStake(msg.sender, msg.value);

        duelId = _nextDuelId++;
        Duel storage d = duels[duelId];
        d.id = duelId;
        d.playerA = msg.sender;
        d.commitA = commitA;
        d.stake = msg.value;
        d.createdAt = uint64(block.timestamp);
        d.status = Status.Open;

        _openIds.push(duelId);
        _openPos[duelId] = _openIds.length;
        _duelsOf[msg.sender].push(duelId);

        emit DuelCreated(duelId, msg.sender, msg.value);
    }

    /// @notice True while B can still join. A pending cancel keeps the duel
    ///         joinable until the moment it becomes effective.
    function isJoinable(uint256 duelId) public view returns (bool) {
        Duel storage d = duels[duelId];
        if (d.status != Status.Open) return false;
        if (d.cancelRequestedAt != 0 && block.timestamp >= uint256(d.cancelRequestedAt) + CANCEL_DELAY) return false;
        return true;
    }

    function joinDuel(uint256 duelId, Choice choiceB) external payable {
        Duel storage d = duels[duelId];
        if (d.status != Status.Open) revert WrongStatus();
        if (!isJoinable(duelId)) revert NoLongerJoinable();
        if (msg.sender == d.playerA) revert CannotDuelYourself();
        if (msg.value != d.stake) revert WrongStake();
        if (choiceB < Choice.Rock || choiceB > Choice.Scissors) revert InvalidChoice();
        _checkStake(msg.sender, msg.value);

        d.playerB = msg.sender;
        d.choiceB = choiceB;
        d.joinedAt = uint64(block.timestamp);
        d.status = Status.Joined;
        d.cancelRequestedAt = 0;

        _removeOpen(duelId);
        _duelsOf[msg.sender].push(duelId);

        emit DuelJoined(duelId, msg.sender, choiceB);
    }

    // ═══════════════════════════════════════════
    // CANCEL (two steps — see header, point 1)
    // ═══════════════════════════════════════════

    function requestCancel(uint256 duelId) external {
        Duel storage d = duels[duelId];
        if (d.status != Status.Open) revert WrongStatus();
        if (msg.sender != d.playerA) revert NotPlayerA();
        if (d.cancelRequestedAt != 0) revert CancelAlreadyRequested();
        d.cancelRequestedAt = uint64(block.timestamp);
        emit CancelRequested(duelId, block.timestamp + CANCEL_DELAY);
    }

    function finalizeCancel(uint256 duelId) external {
        Duel storage d = duels[duelId];
        if (d.status != Status.Open) revert WrongStatus();
        if (msg.sender != d.playerA) revert NotPlayerA();
        if (d.cancelRequestedAt == 0) revert CancelNotRequested();
        if (block.timestamp < uint256(d.cancelRequestedAt) + CANCEL_DELAY) revert CancelNotReady();

        d.status = Status.Cancelled;
        _removeOpen(duelId);
        emit DuelCancelled(duelId, d.playerA);
        _payOrDefer(d.playerA, d.stake);
    }

    // ═══════════════════════════════════════════
    // REVEAL · TIMEOUT
    // ═══════════════════════════════════════════

    function reveal(uint256 duelId, Choice choiceA, bytes32 secretA) external {
        Duel storage d = duels[duelId];
        if (d.status != Status.Joined) revert WrongStatus();
        if (msg.sender != d.playerA) revert NotPlayerA();
        if (block.timestamp >= uint256(d.joinedAt) + REVEAL_DELAY) revert RevealWindowClosed();
        if (choiceA < Choice.Rock || choiceA > Choice.Scissors) revert InvalidChoice();
        if (commitOf(uint8(choiceA), secretA, d.playerA) != d.commitA) revert CommitMismatch();

        d.choiceA = choiceA;

        if (choiceA == d.choiceB) {
            d.status = Status.Tied;
            totalTies++;
            // Pas de tirage sur une égalité : c'est l'issue qu'un joueur tenant
            // les deux wallets peut arranger au moindre coût.
            emit DuelTied(duelId, choiceA);
            _settleTie(d);
            return;
        }

        bool aWins =
            (choiceA == Choice.Rock     && d.choiceB == Choice.Scissors) ||
            (choiceA == Choice.Paper    && d.choiceB == Choice.Rock)     ||
            (choiceA == Choice.Scissors && d.choiceB == Choice.Paper);
        address winner = aWins ? d.playerA : d.playerB;

        d.winner = winner;
        d.status = Status.Finished;
        totalDuels++;
        _countDraw(d);
        emit DuelRevealed(duelId, choiceA, d.choiceB, winner);
        _settleWin(d, winner);
    }

    function claimRevealTimeout(uint256 duelId) external {
        Duel storage d = duels[duelId];
        if (d.status != Status.Joined) revert WrongStatus();
        if (msg.sender != d.playerB) revert NotPlayerB();
        if (block.timestamp < uint256(d.joinedAt) + REVEAL_DELAY) revert TooEarly();

        d.winner = d.playerB;
        d.status = Status.Finished;
        totalDuels++;
        _countDraw(d);
        emit BClaimedTimeout(duelId, d.playerB);
        _settleWin(d, d.playerB);
    }

    // ═══════════════════════════════════════════
    // SETTLEMENT
    // ═══════════════════════════════════════════

    function _settleWin(Duel storage d, address winner) private {
        uint256 pot = d.stake * 2;
        uint256 burnEach = (d.stake * BURN_BPS) / 10000;      // 16% of each stake = 8% of pot
        uint256 creatorCut = (pot * CREATOR_BPS) / 10000;      // 4% of pot
        uint256 winnerCut = pot - 2 * burnEach - creatorCut;   // remainder: 80% of pot, no dust lost

        _payOrDefer(winner, winnerCut);
        _payOrDefer(CREATOR, creatorCut);
        _burnFor(d.playerA, burnEach);
        _burnFor(d.playerB, burnEach);
    }

    function _settleTie(Duel storage d) private {
        uint256 burnEach = (d.stake * TIE_BURN_BPS) / 10000;
        uint256 feeEach  = (d.stake * TIE_FEE_BPS) / 10000;
        uint256 refundEach = d.stake - burnEach - feeEach;

        _payOrDefer(d.playerA, refundEach);
        _payOrDefer(d.playerB, refundEach);
        _payOrDefer(CREATOR, feeEach * 2);
        _burnFor(d.playerA, burnEach);
        _burnFor(d.playerB, burnEach);
    }

    /// @dev Burns through the Ritual so the player is credited. A share smaller
    ///      than the Ritual's minimum (a tie on a very small stake) cannot be
    ///      credited: it still burns, straight to the dead address.
    function _burnFor(address player, uint256 amount) private {
        if (amount == 0) return;
        totalBurned += amount;
        if (amount >= RITUAL.MIN_BURN()) {
            RITUAL.burnFor{value: amount}(player, SOURCE_ARENA);
        } else {
            (bool sent, ) = DEAD_ADDRESS.call{value: amount}("");
            if (!sent) _payOrDefer(CREATOR, amount);   // cannot happen: the dead address has no code
        }
    }

    /// @dev Relic draws: decided duels only (win or forfeit), both players,
    ///      above the draw threshold. Read by the relic contract through
    ///      duelCountOf().
    function _countDraw(Duel storage d) private {
        if (d.stake < DRAW_MIN_STAKE) return;
        _drawDuels[d.playerA]++;
        _drawDuels[d.playerB]++;
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

    function _removeOpen(uint256 duelId) private {
        uint256 pos = _openPos[duelId];
        if (pos == 0) return;
        uint256 idx = pos - 1;
        uint256 lastIdx = _openIds.length - 1;
        if (idx != lastIdx) {
            uint256 lastId = _openIds[lastIdx];
            _openIds[idx] = lastId;
            _openPos[lastId] = idx + 1;
        }
        _openIds.pop();
        delete _openPos[duelId];
    }

    // ═══════════════════════════════════════════
    // READS
    // ═══════════════════════════════════════════

    /// @notice Decided duels (win or forfeit) that count toward relic draws.
    ///         Same name as on testnet, so the relic contract reads it unchanged.
    function duelCountOf(address player) external view returns (uint256) {
        return _drawDuels[player];
    }

    /// @notice Every duel this wallet created or joined.
    function duelsCreatedOrJoined(address player) external view returns (uint256) {
        return _duelsOf[player].length;
    }

    function getDuel(uint256 id) external view returns (Duel memory) { return duels[id]; }
    function getOpenDuels() external view returns (uint256[] memory) { return _openIds; }
    function openDuelCount() external view returns (uint256) { return _openIds.length; }
    function lastDuelId() external view returns (uint256) { return _nextDuelId - 1; }

    function getDuelsBatch(uint256 fromId, uint256 count) external view returns (Duel[] memory batch) {
        if (count > 100) count = 100;
        if (fromId == 0) fromId = 1;
        uint256 last = _nextDuelId;
        if (fromId >= last) return new Duel[](0);
        uint256 n = last - fromId;
        if (n > count) n = count;
        batch = new Duel[](n);
        for (uint256 i = 0; i < n; i++) batch[i] = duels[fromId + i];
    }

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
        for (uint256 i = 0; i < n; i++) ids[i] = all[cursor + i];
        nextCursor = (cursor + n < len) ? cursor + n : 0;
    }

    receive() external payable { revert UseCreateDuel(); }
    fallback() external payable { revert UseCreateDuel(); }
}

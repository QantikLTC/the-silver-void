// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title SilverVoidPFC
 * @notice Rock Paper Scissors PvP duels — variable stake (0.1 / 0.5 / 1 / 5 zkLTC)
 * @dev Commit-reveal. 75% winner / 5% creator / 20% burned. Tie = full refund.
 */
contract SilverVoidPFC {

    address public constant DEAD_ADDRESS = 0x000000000000000000000000000000000000dEaD;
    address public constant CREATOR      = 0x5489667F306a6F03F550FCB129F765f83FaCB24E;

    uint256 public constant STAKE_LOW    = 0.1 ether;
    uint256 public constant STAKE_MID    = 0.5 ether;
    uint256 public constant STAKE_HIGH   = 1   ether;
    uint256 public constant STAKE_MAX    = 5   ether;

    uint256 public constant REVEAL_DELAY = 6 hours;  // creator has 6h to reveal after opponent joins
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

    uint256 public totalBurned;
    uint256 public totalDuels;
    uint256 public totalTies;

    event DuelCreated(uint256 indexed duelId, address indexed playerA, uint256 stake);
    event DuelJoined(uint256 indexed duelId, address indexed playerB, Choice choiceB);
    event DuelRevealed(uint256 indexed duelId, Choice choiceA, Choice choiceB, address winner);
    event DuelTied(uint256 indexed duelId, Choice choice);
    event DuelCancelled(uint256 indexed duelId, address indexed player);
    event BClaimedTimeout(uint256 indexed duelId, address indexed playerB);

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
            (bool ra,) = d.playerA.call{value: d.stake, gas: 30000}("");
            require(ra, "SilverVoidPFC: refund A failed");
            (bool rb,) = d.playerB.call{value: d.stake, gas: 30000}("");
            require(rb, "SilverVoidPFC: refund B failed");
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
        (bool sent,) = d.playerA.call{value: d.stake, gas: 30000}("");
        require(sent, "SilverVoidPFC: refund failed");
    }

    function getOpenDuels() external view returns (uint256[] memory) { return openDuelIds; }
    function getDuel(uint256 id) external view returns (Duel memory) { return duels[id]; }
    function openDuelCount() external view returns (uint256) { return openDuelIds.length; }

    function _distribute(uint256 total, address winner) private {
        uint256 payout     = (total * WINNER_BPS)  / 10000;
        uint256 creatorFee = (total * CREATOR_BPS) / 10000;
        uint256 burnAmount = total - payout - creatorFee;

        (bool sw,) = winner.call{value: payout, gas: 30000}("");
        require(sw, "SilverVoidPFC: winner transfer failed");

        (bool sc,) = CREATOR.call{value: creatorFee, gas: 30000}("");
        require(sc, "SilverVoidPFC: creator transfer failed");

        (bool burned,) = DEAD_ADDRESS.call{value: burnAmount}("");
        if (burned) {
            totalBurned += burnAmount;
        } else {
            (bool sf,) = CREATOR.call{value: burnAmount, gas: 30000}("");
            if (sf) {} // silence warning
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

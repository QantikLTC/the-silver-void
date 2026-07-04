// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

/**
 * @title SilverVoidDuelistSaga
 * @notice Standalone NFT collection — "The Duelist Saga". Each of the 4 NFTs
 *         can only be minted once the player has reached the matching
 *         duel-based milestone (checked off-chain by the frontend via the
 *         Hall of Feats, and re-verified on-chain here against the duel
 *         contract's stats so minting can't be spoofed by a fake frontend).
 *
 *         Deliberately separate from the existing rank-NFT contract — this
 *         collection has its own mint price, its own art, and its own
 *         progression logic (played/won duel counts) rather than burn rank.
 *         Nothing about the existing, working rank-NFT contract is touched.
 *
 * Mint price: 0.05 zkLTC per NFT, paid to CREATOR.
 * Secondary-sale royalty: 2.5% to CREATOR via EIP-2981 (same rate as the
 * existing rank-NFT collection), so marketplaces that respect the standard
 * pay it automatically on resale.
 * Milestones (verified against the duel contract):
 *   1. The Awakening        — played >= 1 duel
 *   2. Lightning Adept      — won >= 15 duels
 *   3. Sanctuary Glimpse    — played >= 40 duels
 *   4. Guardian Ascended    — played >= 84 duels
 *
 * NOTE: "played" and "won" counts are not natively exposed by the duel
 * contract as a per-player counter — they're derived by the frontend via
 * an on-chain scan (same approach as the Duelist leaderboard) and passed
 * here as part of the mint call. To prevent spoofing, this contract takes
 * a minimal, trust-reduced approach: it re-derives the counts itself by
 * reading directly from the duel contract's public getDuel/IDs, exactly
 * the same way the frontend does, so the player cannot fake their progress.
 *
 * TRANSFERABILITY: this contract implements the minimal ERC-721 transfer
 * surface (approve / getApproved / setApprovalForAll / isApprovedForAll /
 * transferFrom / safeTransferFrom) so these NFTs can be listed and sold on
 * any standard marketplace, including The Void Store. It is NOT a full
 * OpenZeppelin ERC-721 (no enumerable/metadata extensions beyond what's
 * needed), but implements everything a marketplace needs to move tokens.
 */

interface IERC721Receiver {
    function onERC721Received(address operator, address from, uint256 tokenId, bytes calldata data)
        external returns (bytes4);
}

interface IDuelContract {
    enum DuelStatus { Open, Joined, Finished, Cancelled, Tied }
    struct Duel {
        uint256 id;
        address playerA;
        address playerB;
        bytes32 commitA;
        uint8 choiceA;
        uint8 choiceB;
        address winner;
        uint256 stake;
        uint256 createdAt;
        uint256 joinedAt;
        DuelStatus status;
    }
    function getDuel(uint256 id) external view returns (Duel memory);
}

contract SilverVoidDuelistSaga {
    string public name = "Silver Void Duelist Saga";
    string public symbol = "SVDS";

    address public immutable CREATOR;
    IDuelContract public immutable DUEL_CONTRACT;

    uint256 public constant MINT_PRICE = 0.05 ether; // zkLTC
    uint256 public constant ROYALTY_BPS = 250; // 2.5% (basis points out of 10,000) — same as the rank-NFT collection
    uint8   public constant SAGA_COUNT = 4;

    // Milestone thresholds
    uint256 public constant AWAKENING_MIN_PLAYED   = 1;
    uint256 public constant LIGHTNING_MIN_WON       = 15;
    uint256 public constant SANCTUARY_MIN_PLAYED    = 40;
    uint256 public constant GUARDIAN_MIN_PLAYED     = 84;

    // sagaId: 1=Awakening, 2=Lightning Adept, 3=Sanctuary Glimpse, 4=Guardian Ascended
    mapping(address => mapping(uint8 => bool)) public minted; // player => sagaId => minted?
    mapping(uint256 => address) public ownerOf;
    mapping(uint256 => uint8) public tokenSagaId;
    uint256 public totalSupply;

    // ── Metadata (for tokenURI / wallet & marketplace display) ──
    string[5] private _sagaNames;  // index 0 unused, 1-4 = sagaId
    string[5] private _sagaMetadataURIs; // full URI to a hosted JSON metadata file per sagaId

    // ── ERC-721 transfer/approval state ──
    mapping(uint256 => address) private _tokenApprovals;
    mapping(address => mapping(address => bool)) private _operatorApprovals;
    mapping(address => uint256) public balanceOf;

    // Cap on how many duel IDs we'll scan per mint call, to keep gas bounded
    // as the total number of duels grows. Generous for the foreseeable future.
    uint256 public constant MAX_SCAN = 3000;

    event SagaMinted(address indexed player, uint8 sagaId, uint256 tokenId);
    event Transfer(address indexed from, address indexed to, uint256 indexed tokenId);
    event Approval(address indexed owner, address indexed approved, uint256 indexed tokenId);
    event ApprovalForAll(address indexed owner, address indexed operator, bool approved);

    constructor(address creator, address duelContract) {
        CREATOR = creator;
        DUEL_CONTRACT = IDuelContract(duelContract);

        _sagaNames[1] = "The Awakening";
        _sagaNames[2] = "Lightning Adept";
        _sagaNames[3] = "Sanctuary Glimpse";
        _sagaNames[4] = "Guardian Ascended";

        // Metadata JSONs live on Arweave — pay-once permanent storage. Each
        // JSON's "image" field also points to Arweave. Nothing about these
        // tokens depends on any single gateway or pinning subscription
        // staying alive anymore (the previous URIs pointed to a dedicated
        // Pinata gateway, hardcoded forever into every minted token).
        _sagaMetadataURIs[1] = "https://arweave.net/WTHkSHGu7yEp61E-ufiY0hTA5cwXQjLbov9QaS-YWWE";
        _sagaMetadataURIs[2] = "https://arweave.net/4G-0hjf4fvcQ3-74r5ibkKjfBr8PfcSHcsSqW-eMnfA";
        _sagaMetadataURIs[3] = "https://arweave.net/6-4uVLnqcFTARailo3T6-0hz06JR9vTcNjmKY-Vl0sA";
        _sagaMetadataURIs[4] = "https://arweave.net/wMWgBxpXHqPg8jyVh-ARhl0zTKTK_kkBoWP005z8iM0";
    }

    /// @notice Counts a player's played and won duels by scanning the duel contract directly.
    function _playerStats(address player) internal view returns (uint256 played, uint256 won) {
        address zero = address(0);
        uint256 misses = 0;
        for (uint256 id = 1; id <= MAX_SCAN && misses < 3; id++) {
            IDuelContract.Duel memory d;
            // getDuel never reverts for out-of-range ids in the duel contract
            // (it returns a zero-initialized struct), so no try/catch needed.
            d = DUEL_CONTRACT.getDuel(id);
            if (d.playerA == zero) { misses++; continue; }
            misses = 0;

            bool involved = (d.playerA == player) || (d.playerB == player);
            if (!involved) continue;

            // Only finished/tied duels count as "played" for milestone purposes
            if (d.status == IDuelContract.DuelStatus.Finished || d.status == IDuelContract.DuelStatus.Tied) {
                played++;
                if (d.status == IDuelContract.DuelStatus.Finished && d.winner == player) {
                    won++;
                }
            }
        }
    }

    function eligibleFor(address player, uint8 sagaId) public view returns (bool) {
        (uint256 played, uint256 won) = _playerStats(player);
        if (sagaId == 1) return played >= AWAKENING_MIN_PLAYED;
        if (sagaId == 2) return won >= LIGHTNING_MIN_WON;
        if (sagaId == 3) return played >= SANCTUARY_MIN_PLAYED;
        if (sagaId == 4) return played >= GUARDIAN_MIN_PLAYED;
        return false;
    }

    function mint(uint8 sagaId) external payable {
        require(sagaId >= 1 && sagaId <= SAGA_COUNT, "SilverVoidDuelistSaga: invalid sagaId");
        require(!minted[msg.sender][sagaId], "SilverVoidDuelistSaga: already minted");
        require(msg.value == MINT_PRICE, "SilverVoidDuelistSaga: incorrect mint fee (0.05 zkLTC)");
        require(eligibleFor(msg.sender, sagaId), "SilverVoidDuelistSaga: milestone not reached yet");

        minted[msg.sender][sagaId] = true;
        totalSupply++;
        uint256 tokenId = totalSupply;
        ownerOf[tokenId] = msg.sender;
        tokenSagaId[tokenId] = sagaId;
        balanceOf[msg.sender]++;

        (bool sent, ) = CREATOR.call{value: msg.value, gas: 30000}("");
        require(sent, "SilverVoidDuelistSaga: payment transfer failed");

        emit SagaMinted(msg.sender, sagaId, tokenId);
        emit Transfer(address(0), msg.sender, tokenId);
    }

    function hasMinted(address player, uint8 sagaId) external view returns (bool) {
        return minted[player][sagaId];
    }

    /// @notice Standard ERC-721 metadata endpoint. Points to a small JSON
    ///         metadata file hosted on IPFS (one per sagaId) rather than
    ///         building it on-chain — simpler and more reliable than the
    ///         Base64/assembly approach, which kept reverting unpredictably.
    function tokenURI(uint256 tokenId) external view returns (string memory) {
        address owner = ownerOf[tokenId];
        require(owner != address(0), "SilverVoidDuelistSaga: nonexistent token");
        uint8 sagaId = tokenSagaId[tokenId];
        return _sagaMetadataURIs[sagaId];
    }

    // ════════════════════ ERC-721 TRANSFER SURFACE ════════════════════
    // Minimal but standard-compliant implementation — enough for any
    // marketplace (including The Void Store) to list, approve, and
    // transfer these tokens, mirroring OpenZeppelin's ERC-721 semantics.

    function approve(address to, uint256 tokenId) external {
        address owner = ownerOf[tokenId];
        require(owner != address(0), "SilverVoidDuelistSaga: nonexistent token");
        require(
            msg.sender == owner || _operatorApprovals[owner][msg.sender],
            "SilverVoidDuelistSaga: not owner nor approved operator"
        );
        _tokenApprovals[tokenId] = to;
        emit Approval(owner, to, tokenId);
    }

    function getApproved(uint256 tokenId) external view returns (address) {
        require(ownerOf[tokenId] != address(0), "SilverVoidDuelistSaga: nonexistent token");
        return _tokenApprovals[tokenId];
    }

    function setApprovalForAll(address operator, bool approved) external {
        require(operator != msg.sender, "SilverVoidDuelistSaga: approve to caller");
        _operatorApprovals[msg.sender][operator] = approved;
        emit ApprovalForAll(msg.sender, operator, approved);
    }

    function isApprovedForAll(address owner, address operator) external view returns (bool) {
        return _operatorApprovals[owner][operator];
    }

    function _isApprovedOrOwner(address spender, uint256 tokenId) internal view returns (bool) {
        address owner = ownerOf[tokenId];
        return spender == owner || _tokenApprovals[tokenId] == spender || _operatorApprovals[owner][spender];
    }

    function transferFrom(address from, address to, uint256 tokenId) public {
        require(ownerOf[tokenId] == from, "SilverVoidDuelistSaga: from is not owner");
        require(to != address(0), "SilverVoidDuelistSaga: transfer to zero address");
        require(_isApprovedOrOwner(msg.sender, tokenId), "SilverVoidDuelistSaga: not approved or owner");

        // Clear any existing approval on transfer (standard ERC-721 behavior)
        _tokenApprovals[tokenId] = address(0);

        ownerOf[tokenId] = to;
        balanceOf[from]--;
        balanceOf[to]++;

        emit Transfer(from, to, tokenId);
    }

    function safeTransferFrom(address from, address to, uint256 tokenId) external {
        safeTransferFrom(from, to, tokenId, "");
    }

    function safeTransferFrom(address from, address to, uint256 tokenId, bytes memory data) public {
        transferFrom(from, to, tokenId);
        if (to.code.length > 0) {
            try IERC721Receiver(to).onERC721Received(msg.sender, from, tokenId, data) returns (bytes4 retval) {
                require(retval == IERC721Receiver.onERC721Received.selector, "SilverVoidDuelistSaga: receiver rejected token");
            } catch {
                revert("SilverVoidDuelistSaga: transfer to non-ERC721Receiver implementer");
            }
        }
    }

    /// @notice EIP-2981 royalty info — 2.5% of any sale price, paid to CREATOR.
    ///         Marketplaces that respect this standard query it automatically
    ///         on resale; it is NOT enforced by this contract itself (no
    ///         marketplace is obligated to honor it, same limitation as any
    ///         EIP-2981 implementation).
    function royaltyInfo(uint256 /* tokenId */, uint256 salePrice)
        external view returns (address receiver, uint256 royaltyAmount)
    {
        return (CREATOR, (salePrice * ROYALTY_BPS) / 10000);
    }

    /// @notice ERC-165 interface detection — declares ERC-721 (0x80ac58cd),
    ///         EIP-2981 royalties (0x2a55205a), and ERC-165 itself (0x01ffc9a7).
    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == 0x80ac58cd || interfaceId == 0x2a55205a || interfaceId == 0x01ffc9a7;
    }
}

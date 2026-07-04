// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

/**
 * @title SilverVoidStore — "The Void Store" (mainnet revision)
 * @notice A generic NFT marketplace, open to any ERC-721 contract, built
 *         around the same burn-centric philosophy as the rest of Silver Void.
 *
 * Two burn touchpoints:
 *   1. LISTING — to list an NFT for sale, the seller pays a small fee that is
 *      split: part burned (sent to the dead address), part to CREATOR.
 *        LISTING_BURN = 0.005 zkLTC (burned)
 *        LISTING_FEE  = 0.0025 zkLTC (to CREATOR)
 *   2. SALE — when a listing sells, the payment is split exactly like a duel:
 *        80% to the seller
 *        17% burned forever
 *        3%  to CREATOR
 *      If the NFT contract implements EIP-2981 (royaltyInfo), that royalty is
 *      deducted from the seller's 80% share first and paid to the royalty
 *      receiver — same convention OpenSea and other marketplaces use.
 *
 * The seller must approve() this contract for the specific tokenId (or
 * setApprovalForAll) BEFORE calling list() — standard ERC-721 marketplace
 * flow. This contract never holds NFTs in escrow; it only transfers on sale,
 * reducing the attack surface (no NFTs ever sit inside this contract).
 *
 * ═══ CHANGES FROM THE TESTNET VERSION ═══
 *
 * 1. PAGINATED GETTER — getActiveListings(cursor, count). The frontend used
 *    to loop getListing(id) one call at a time for every id ever created,
 *    which meant N RPC round-trips per Store refresh and was a major source
 *    of RPC rate-limiting. This returns a page of active listings in ONE
 *    call.
 *
 * 2. ON-CHAIN STATS — totalSold / totalVolume / totalBurned counters,
 *    updated as sales happen. The site's Store stats banner previously had
 *    to scan the contract's full event history to compute these (another
 *    heavy RPC pattern, since removed); now it's a single getStats() call.
 *
 * 3. PULL PAYMENTS — every outgoing transfer (seller, creator, royalty)
 *    that fails no longer reverts the whole sale. Instead the amount is
 *    credited to pendingWithdrawals[recipient], claimable anytime via
 *    withdraw(). Rationale: transfers use a 30k gas stipend (deliberate,
 *    anti-reentrancy), but smart-contract wallets (Safe, AA accounts) can
 *    need more than that in their receive() — under the old code such a
 *    recipient could NEVER be paid (every tx reverts). Burns to the dead
 *    address keep the hard require (the dead address has no code; that
 *    call cannot legitimately fail).
 */

interface IERC721 {
    function ownerOf(uint256 tokenId) external view returns (address);
    function getApproved(uint256 tokenId) external view returns (address);
    function isApprovedForAll(address owner, address operator) external view returns (bool);
    function safeTransferFrom(address from, address to, uint256 tokenId) external;
}

interface IERC2981 {
    function royaltyInfo(uint256 tokenId, uint256 salePrice)
        external view returns (address receiver, uint256 royaltyAmount);
}

contract SilverVoidStore {
    address public immutable CREATOR;
    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;

    uint256 public constant LISTING_BURN = 0.005 ether;  // burned on listing
    uint256 public constant LISTING_FEE  = 0.0025 ether; // to CREATOR on listing
    uint256 public constant LISTING_COST = LISTING_BURN + LISTING_FEE;

    uint256 public constant SELLER_BPS  = 8000; // 80%
    uint256 public constant BURN_BPS    = 1700; // 17%
    uint256 public constant CREATOR_BPS =  300; // 3%

    struct Listing {
        address seller;
        address nftContract;
        uint256 tokenId;
        uint256 price;
        bool active;
    }

    uint256 public nextListingId = 1;
    mapping(uint256 => Listing) public listings;

    // ═══ On-chain stats (new) ═══
    uint256 public totalSold;    // number of completed sales
    uint256 public totalVolume;  // sum of sale prices, in wei
    uint256 public totalBurned;  // zkLTC burned by this contract (listing burns + sale burns), in wei

    // ═══ Pull payments (new) ═══
    mapping(address => uint256) public pendingWithdrawals;

    event Listed(uint256 indexed listingId, address indexed seller, address indexed nftContract, uint256 tokenId, uint256 price);
    event Cancelled(uint256 indexed listingId);
    event Sold(uint256 indexed listingId, address indexed buyer, address indexed seller, uint256 price);
    event PaymentDeferred(address indexed recipient, uint256 amount); // direct send failed; credited for withdraw()
    event Withdrawn(address indexed recipient, uint256 amount);

    constructor(address creator) {
        CREATOR = creator;
    }

    /// @notice List an ERC-721 token for sale. Requires prior approval of
    ///         this contract for the token (approve or setApprovalForAll).
    ///         Costs LISTING_COST in zkLTC, split between burn and CREATOR.
    function list(address nftContract, uint256 tokenId, uint256 price) external payable returns (uint256 listingId) {
        require(price > 0, "SilverVoidStore: price must be > 0");
        require(msg.value == LISTING_COST, "SilverVoidStore: incorrect listing fee");

        IERC721 nft = IERC721(nftContract);
        require(nft.ownerOf(tokenId) == msg.sender, "SilverVoidStore: not the owner");
        require(
            nft.getApproved(tokenId) == address(this) || nft.isApprovedForAll(msg.sender, address(this)),
            "SilverVoidStore: contract not approved for this token"
        );

        listingId = nextListingId++;
        listings[listingId] = Listing({
            seller: msg.sender,
            nftContract: nftContract,
            tokenId: tokenId,
            price: price,
            active: true
        });

        (bool burnSent, ) = DEAD.call{value: LISTING_BURN, gas: 30000}("");
        require(burnSent, "SilverVoidStore: listing burn failed");
        totalBurned += LISTING_BURN;

        _payOrDefer(CREATOR, LISTING_FEE);

        emit Listed(listingId, msg.sender, nftContract, tokenId, price);
    }

    /// @notice Cancel an active listing. Only the seller can cancel. Free —
    ///         no fee is charged or refunded; the listing fee was already
    ///         spent (burned + paid) at listing time.
    function cancel(uint256 listingId) external {
        Listing storage l = listings[listingId];
        require(l.active, "SilverVoidStore: listing not active");
        require(l.seller == msg.sender, "SilverVoidStore: not your listing");
        l.active = false;
        emit Cancelled(listingId);
    }

    /// @notice Buy a listed NFT. Pays exactly the listed price. Splits the
    ///         payment 80/17/3 (seller/burn/creator), deducting an EIP-2981
    ///         royalty from the seller's share first, if the NFT contract
    ///         implements it.
    function buy(uint256 listingId) external payable {
        Listing storage l = listings[listingId];
        require(l.active, "SilverVoidStore: listing not active");
        require(msg.value == l.price, "SilverVoidStore: incorrect payment amount");

        address seller = l.seller;
        address nftContract = l.nftContract;
        uint256 tokenId = l.tokenId;
        uint256 price = l.price;

        l.active = false; // effects before interactions

        _verifyStillSellable(nftContract, tokenId, seller);
        IERC721(nftContract).safeTransferFrom(seller, msg.sender, tokenId);
        _settlePayment(nftContract, tokenId, price, seller);

        totalSold += 1;
        totalVolume += price;

        emit Sold(listingId, msg.sender, seller, price);
    }

    /// @notice Claim any payments that couldn't be delivered directly (e.g.
    ///         because the recipient is a smart-contract wallet whose
    ///         receive() needs more than the 30k gas stipend).
    function withdraw() external {
        uint256 amount = pendingWithdrawals[msg.sender];
        require(amount > 0, "SilverVoidStore: nothing to withdraw");
        pendingWithdrawals[msg.sender] = 0; // effects before interactions
        (bool sent, ) = msg.sender.call{value: amount}("");
        require(sent, "SilverVoidStore: withdraw failed");
        emit Withdrawn(msg.sender, amount);
    }

    // ═══════════════════════════════════════════
    // PAGINATED / STATS READ FUNCTIONS (new)
    // ═══════════════════════════════════════════

    /// @notice Returns up to `count` ACTIVE listings with id >= cursor, plus
    ///         their ids and the cursor to resume from. One RPC call replaces
    ///         the frontend's old getListing()-per-id loop.
    /// @param cursor   Listing id to start scanning from (1 for the first page).
    /// @param count    Max number of active listings to return (capped at 100).
    /// @return ids     The listing ids of the returned entries.
    /// @return page    The listing structs, same order as ids.
    /// @return nextCursor  Pass this as cursor to fetch the next page;
    ///                     0 means the end was reached.
    function getActiveListings(uint256 cursor, uint256 count)
        external view returns (uint256[] memory ids, Listing[] memory page, uint256 nextCursor)
    {
        if (count > 100) count = 100;
        if (cursor == 0) cursor = 1;

        uint256 last = nextListingId; // exclusive upper bound
        uint256[] memory tmpIds = new uint256[](count);
        uint256 found = 0;
        uint256 id = cursor;

        for (; id < last && found < count; id++) {
            if (listings[id].active) {
                tmpIds[found] = id;
                found++;
            }
        }

        ids = new uint256[](found);
        page = new Listing[](found);
        for (uint256 i = 0; i < found; i++) {
            ids[i] = tmpIds[i];
            page[i] = listings[tmpIds[i]];
        }
        nextCursor = (id < last) ? id : 0;
    }

    /// @notice Global marketplace statistics in a single call — replaces the
    ///         frontend's old full event-history scan.
    function getStats() external view returns (
        uint256 _totalSold,
        uint256 _totalVolume,
        uint256 _totalBurned,
        uint256 _totalListingsCreated
    ) {
        return (totalSold, totalVolume, totalBurned, nextListingId - 1);
    }

    function getListing(uint256 listingId) external view returns (Listing memory) {
        return listings[listingId];
    }

    // ═══════════════════════════════════════════
    // INTERNAL
    // ═══════════════════════════════════════════

    /// @dev Re-checks ownership/approval at sale time — protects against the
    ///      seller having transferred or revoked approval since listing.
    function _verifyStillSellable(address nftContract, uint256 tokenId, address seller) internal view {
        IERC721 nft = IERC721(nftContract);
        require(nft.ownerOf(tokenId) == seller, "SilverVoidStore: seller no longer owns token");
        require(
            nft.getApproved(tokenId) == address(this) || nft.isApprovedForAll(seller, address(this)),
            "SilverVoidStore: approval was revoked"
        );
    }

    /// @dev Splits the payment 80/17/3 (seller/burn/creator), deducting an
    ///      EIP-2981 royalty from the seller's share first, if supported.
    function _settlePayment(address nftContract, uint256 tokenId, uint256 price, address seller) internal {
        uint256 sellerCut = (price * SELLER_BPS) / 10000;
        uint256 burnCut = (price * BURN_BPS) / 10000;
        uint256 creatorCut = price - sellerCut - burnCut; // remainder avoids rounding dust

        (address royaltyReceiver, uint256 royaltyAmount) = _royaltyFor(nftContract, tokenId, price, sellerCut);
        if (royaltyAmount > 0) {
            sellerCut -= royaltyAmount;
            _payOrDefer(royaltyReceiver, royaltyAmount);
        }

        _payOrDefer(seller, sellerCut);

        // The burn keeps its hard require: the dead address has no code, so
        // this call cannot legitimately fail — if it somehow does, something
        // is very wrong and reverting is the right response.
        (bool bSent, ) = DEAD.call{value: burnCut, gas: 30000}("");
        require(bSent, "SilverVoidStore: sale burn failed");
        totalBurned += burnCut;

        _payOrDefer(CREATOR, creatorCut);
    }

    /// @dev Attempts a direct transfer with a 30k gas stipend (deliberate,
    ///      anti-reentrancy). If it fails — typically a smart-contract
    ///      wallet needing more gas in receive() — the amount is credited
    ///      for later withdraw() instead of reverting the whole sale.
    function _payOrDefer(address recipient, uint256 amount) internal {
        if (amount == 0) return;
        (bool sent, ) = recipient.call{value: amount, gas: 30000}("");
        if (!sent) {
            pendingWithdrawals[recipient] += amount;
            emit PaymentDeferred(recipient, amount);
        }
    }

    /// @dev Returns (receiver, amount) for an EIP-2981 royalty, or (0, 0) if
    ///      the NFT contract doesn't implement it or the amount is invalid.
    function _royaltyFor(address nftContract, uint256 tokenId, uint256 price, uint256 sellerCut)
        internal view returns (address, uint256)
    {
        try IERC2981(nftContract).royaltyInfo(tokenId, price) returns (address r, uint256 amt) {
            if (r != address(0) && amt > 0 && amt <= sellerCut) {
                return (r, amt);
            }
        } catch {
            // NFT contract doesn't support EIP-2981 — no royalty.
        }
        return (address(0), 0);
    }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title SilverVoidStore
 * @notice The Lower City — an NFT market open to any ERC-721 on LitVM —
 *         mainnet revision.
 *
 * ═══ THE ECONOMY ═══
 *
 *   Listing  : a fixed fee, set at deployment. Its burn part goes through the
 *              Ritual, credited to the SELLER; the rest goes to the creator.
 *   Sale     : 3% of the price is burned through the Ritual, credited to the
 *              BUYER — the one who paid. A small creator share (set at
 *              deployment, capped at 5%) goes to the creator. The seller
 *              receives the rest, minus the collection's royalty (EIP-2981)
 *              if it declares one.
 *   Cancel   : free.
 *
 * ═══ WHAT CHANGED FROM THE TESTNET CONTRACT, AND WHY ═══
 *
 * 1. 3% BURNED INSTEAD OF 17% + 3%. The market should be a place people
 *    choose, not a tax. Sellers keep 97%.
 * 2. BURNS COUNT FOR RANK. Both burns go through the Ritual's burnFor(): the
 *    sale burn lifts the buyer's rank, the listing burn the seller's.
 * 3. ONE LISTING PER TOKEN. Listing a token that already has an active
 *    listing by the same seller replaces it, instead of leaving a stale offer
 *    that could never be bought.
 * 4. FEES SET AT DEPLOYMENT, not hard-coded, so mainnet values can follow the
 *    real price of LTC.
 * 5. A REENTRANCY GUARD on buy(): the NFT transfer can call into the buyer's
 *    contract, so the whole purchase is locked while it runs.
 *
 * ═══ KEPT ═══
 *
 *   No escrow (the NFT never leaves the seller's wallet until sold), approval
 *   re-checked at sale, pull payments for wallets that refuse a transfer,
 *   paginated reads and on-chain stats.
 */

interface IERC721S {
    function ownerOf(uint256 tokenId) external view returns (address);
    function getApproved(uint256 tokenId) external view returns (address);
    function isApprovedForAll(address owner, address operator) external view returns (bool);
    function safeTransferFrom(address from, address to, uint256 tokenId) external;
}

interface IERC2981S {
    function royaltyInfo(uint256 tokenId, uint256 salePrice) external view returns (address receiver, uint256 royaltyAmount);
}

interface IRitualS {
    function burnFor(address beneficiary, uint8 source) external payable;
    function MIN_BURN() external view returns (uint256);
}

contract SilverVoidStore {

    address public constant DEAD_ADDRESS = 0x000000000000000000000000000000000000dEaD;
    uint8   public constant SOURCE_STORE = 1;

    /// @notice Share of the sale price burned for the buyer, in basis points.
    uint256 public constant BURN_BPS = 300;   // 3%

    IRitualS public immutable RITUAL;
    address  public immutable CREATOR;

    /// @notice Creator share of each sale, in basis points (set at deployment).
    uint256 public immutable SALE_FEE_BPS;
    uint256 public constant  MAX_SALE_FEE_BPS = 500;   // never more than 5%

    /// @notice Listing fee: burned part (credited to the seller) and creator part.
    uint256 public immutable LISTING_BURN;
    uint256 public immutable LISTING_FEE;

    struct Listing {
        address seller;
        address nftContract;
        uint256 tokenId;
        uint256 price;
        bool active;
    }

    uint256 public nextListingId = 1;
    mapping(uint256 => Listing) public listings;

    /// @notice nft => tokenId => active listing id (0 = none).
    mapping(address => mapping(uint256 => uint256)) public activeListingOf;

    uint256 public totalSold;
    uint256 public totalVolume;
    uint256 public totalBurned;

    mapping(address => uint256) public pendingWithdrawals;

    uint256 private _locked = 1;

    event Listed(uint256 indexed listingId, address indexed seller, address indexed nftContract, uint256 tokenId, uint256 price);
    event Cancelled(uint256 indexed listingId);
    event Replaced(uint256 indexed oldListingId, uint256 indexed newListingId);
    event Sold(uint256 indexed listingId, address indexed buyer, address indexed seller, uint256 price);
    event PaymentDeferred(address indexed recipient, uint256 amount);
    event Withdrawn(address indexed recipient, uint256 amount);

    error BadConfig();
    error ZeroPrice();
    error BadFee(uint256 sent, uint256 expected);
    error NotOwner();
    error NotApproved();
    error NotActive();
    error NotYourListing();
    error WrongPayment(uint256 sent, uint256 expected);
    error SellerNoLongerOwns();
    error ApprovalRevoked();
    error CannotBuyYourOwn();
    error Reentrancy();
    error NothingToWithdraw();
    error WithdrawFailed();
    error UseList();

    modifier nonReentrant() {
        if (_locked != 1) revert Reentrancy();
        _locked = 2;
        _;
        _locked = 1;
    }

    /**
     * @param ritual       The Ritual (burnFor).
     * @param creator      Receives the creator part of listing fees.
     * @param listingBurn  Part of the listing fee burned for the seller.
     * @param listingFee   Part of the listing fee paid to the creator.
     * @param saleFeeBps   Creator share of each sale, in basis points (100 = 1%).
     */
    constructor(address ritual, address creator, uint256 listingBurn, uint256 listingFee, uint256 saleFeeBps) {
        if (ritual == address(0) || creator == address(0)) revert BadConfig();
        if (saleFeeBps > MAX_SALE_FEE_BPS) revert BadConfig();
        SALE_FEE_BPS = saleFeeBps;
        RITUAL = IRitualS(ritual);
        CREATOR = creator;
        LISTING_BURN = listingBurn;
        LISTING_FEE = listingFee;
    }

    function listingCost() public view returns (uint256) { return LISTING_BURN + LISTING_FEE; }

    // ═══════════════════════════════════════════
    // LIST · CANCEL
    // ═══════════════════════════════════════════

    function list(address nftContract, uint256 tokenId, uint256 price) external payable nonReentrant returns (uint256 listingId) {
        if (price == 0) revert ZeroPrice();
        uint256 cost = listingCost();
        if (msg.value != cost) revert BadFee(msg.value, cost);

        IERC721S nft = IERC721S(nftContract);
        if (nft.ownerOf(tokenId) != msg.sender) revert NotOwner();
        if (nft.getApproved(tokenId) != address(this) && !nft.isApprovedForAll(msg.sender, address(this))) revert NotApproved();

        listingId = nextListingId++;
        listings[listingId] = Listing(msg.sender, nftContract, tokenId, price, true);

        // Un seul prix affiché par jeton : la nouvelle annonce remplace l'ancienne.
        uint256 previous = activeListingOf[nftContract][tokenId];
        if (previous != 0 && listings[previous].active) {
            listings[previous].active = false;
            emit Replaced(previous, listingId);
        }
        activeListingOf[nftContract][tokenId] = listingId;

        _burnFor(msg.sender, LISTING_BURN);
        _payOrDefer(CREATOR, LISTING_FEE);

        emit Listed(listingId, msg.sender, nftContract, tokenId, price);
    }

    function cancel(uint256 listingId) external {
        Listing storage l = listings[listingId];
        if (!l.active) revert NotActive();
        if (l.seller != msg.sender) revert NotYourListing();
        l.active = false;
        if (activeListingOf[l.nftContract][l.tokenId] == listingId) delete activeListingOf[l.nftContract][l.tokenId];
        emit Cancelled(listingId);
    }

    // ═══════════════════════════════════════════
    // BUY
    // ═══════════════════════════════════════════

    function buy(uint256 listingId) external payable nonReentrant {
        Listing storage l = listings[listingId];
        if (!l.active) revert NotActive();
        if (msg.value != l.price) revert WrongPayment(msg.value, l.price);
        if (msg.sender == l.seller) revert CannotBuyYourOwn();

        address seller = l.seller;
        address nftContract = l.nftContract;
        uint256 tokenId = l.tokenId;
        uint256 price = l.price;

        l.active = false;
        if (activeListingOf[nftContract][tokenId] == listingId) delete activeListingOf[nftContract][tokenId];

        IERC721S nft = IERC721S(nftContract);
        if (nft.ownerOf(tokenId) != seller) revert SellerNoLongerOwns();
        if (nft.getApproved(tokenId) != address(this) && !nft.isApprovedForAll(seller, address(this))) revert ApprovalRevoked();

        nft.safeTransferFrom(seller, msg.sender, tokenId);

        uint256 burnCut = (price * BURN_BPS) / 10000;
        uint256 creatorCut = (price * SALE_FEE_BPS) / 10000;
        uint256 sellerCut = price - burnCut - creatorCut;

        (address royaltyReceiver, uint256 royalty) = _royaltyFor(nftContract, tokenId, price, sellerCut);
        if (royalty > 0) {
            sellerCut -= royalty;
            _payOrDefer(royaltyReceiver, royalty);
        }
        _payOrDefer(seller, sellerCut);
        _payOrDefer(CREATOR, creatorCut);
        _burnFor(msg.sender, burnCut);

        totalSold += 1;
        totalVolume += price;

        emit Sold(listingId, msg.sender, seller, price);
    }

    // ═══════════════════════════════════════════
    // INTERNAL
    // ═══════════════════════════════════════════

    /// @dev Burns through the Ritual so the player is credited. Below the
    ///      Ritual's minimum (a very cheap sale), it still burns, uncredited.
    function _burnFor(address player, uint256 amount) private {
        if (amount == 0) return;
        totalBurned += amount;
        if (amount >= RITUAL.MIN_BURN()) {
            RITUAL.burnFor{value: amount}(player, SOURCE_STORE);
        } else {
            (bool sent, ) = DEAD_ADDRESS.call{value: amount}("");
            if (!sent) _payOrDefer(CREATOR, amount);
        }
    }

    function _payOrDefer(address recipient, uint256 amount) private {
        if (amount == 0) return;
        (bool sent, ) = recipient.call{value: amount, gas: 30000}("");
        if (!sent) {
            pendingWithdrawals[recipient] += amount;
            emit PaymentDeferred(recipient, amount);
        }
    }

    function _royaltyFor(address nftContract, uint256 tokenId, uint256 price, uint256 sellerCut) private view returns (address, uint256) {
        try IERC2981S(nftContract).royaltyInfo(tokenId, price) returns (address r, uint256 amt) {
            if (r != address(0) && amt > 0 && amt <= sellerCut) return (r, amt);
        } catch {}
        return (address(0), 0);
    }

    function withdraw() external nonReentrant {
        uint256 amount = pendingWithdrawals[msg.sender];
        if (amount == 0) revert NothingToWithdraw();
        pendingWithdrawals[msg.sender] = 0;
        (bool sent, ) = msg.sender.call{value: amount}("");
        if (!sent) revert WithdrawFailed();
        emit Withdrawn(msg.sender, amount);
    }

    // ═══════════════════════════════════════════
    // READS
    // ═══════════════════════════════════════════

    function getListing(uint256 listingId) external view returns (Listing memory) { return listings[listingId]; }

    function getActiveListings(uint256 cursor, uint256 count)
        external view returns (uint256[] memory ids, Listing[] memory page, uint256 nextCursor)
    {
        if (count > 100) count = 100;
        if (cursor == 0) cursor = 1;
        uint256 last = nextListingId;
        uint256[] memory tmp = new uint256[](count);
        uint256 found = 0;
        uint256 id = cursor;
        for (; id < last && found < count; id++) if (listings[id].active) tmp[found++] = id;
        ids = new uint256[](found);
        page = new Listing[](found);
        for (uint256 i = 0; i < found; i++) { ids[i] = tmp[i]; page[i] = listings[tmp[i]]; }
        nextCursor = (id < last) ? id : 0;
    }

    function getStats() external view returns (uint256 _totalSold, uint256 _totalVolume, uint256 _totalBurned, uint256 _totalListingsCreated) {
        return (totalSold, totalVolume, totalBurned, nextListingId - 1);
    }

    receive() external payable { revert UseList(); }
    fallback() external payable { revert UseList(); }
}

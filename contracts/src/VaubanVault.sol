// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title VaubanVault
/// @notice Holds funds for one autonomous agent and rules on every call it makes.
///         Order of ruling: keep (frozen?) -> curtain (allowlist) -> ditch (caps) -> gate (hold?) -> land.
///         The agent can only call `execute` and `release`. Everything else is owner-only.
contract VaubanVault {
    // ---------------------------------------------------------------- types

    /// Caps for one asset (address(0) = native ETH). Unset asset = no value may move.
    struct Limits {
        bool set;
        uint128 perTx;
        uint128 perHour;
        uint128 perDay;
        uint128 holdAbove; // 0 = never hold
    }

    struct Spend {
        uint64 hourEpoch;
        uint64 dayEpoch;
        uint128 hourSpent;
        uint128 daySpent;
    }

    struct Held {
        bytes32 callHash;
        uint64 eta;
    }

    // ------------------------------------------------------------ selectors

    bytes4 private constant TRANSFER = 0xa9059cbb; // transfer(address,uint256)
    bytes4 private constant TRANSFER_FROM = 0x23b872dd; // transferFrom(address,address,uint256)
    bytes4 private constant APPROVE = 0x095ea7b3; // approve(address,uint256)
    bytes4 private constant INCREASE_ALLOWANCE = 0x39509351; // increaseAllowance(address,uint256)
    bytes4 private constant SET_APPROVAL_FOR_ALL = 0xa22cb465; // setApprovalForAll(address,bool)
    bytes4 private constant PLAIN = 0x00000000; // empty calldata (plain ETH send)

    // --------------------------------------------------------------- state

    address public owner;
    address public pendingOwner;
    address public agent;
    bool public frozen;
    uint64 public gateDelay;
    uint64 public revision;
    uint256 public nonce;

    mapping(address target => mapping(bytes4 selector => bool)) public allowed;
    mapping(address target => uint256) public allowedCount;
    mapping(address asset => Limits) public limits;
    mapping(address asset => Spend) public spent;
    mapping(bytes32 id => Held) public held;

    uint256 private _lock = 1;

    // -------------------------------------------------------------- events

    event Passed(address indexed target, bytes4 indexed selector, uint256 value, bytes32 heldId);
    event HeldAtGate(bytes32 indexed id, address indexed target, uint256 value, bytes data, uint64 eta);
    event Cancelled(bytes32 indexed id);
    event Frozen(bool frozen);
    event PolicyRevised(uint64 indexed revision);
    event Listed(address indexed target, bytes4 indexed selector, bool ok);
    event LimitsSet(address indexed asset, bool set, uint128 perTx, uint128 perHour, uint128 perDay, uint128 holdAbove);
    event AgentSet(address indexed agent);
    event OwnershipTransferStarted(address indexed from, address indexed to);
    event OwnershipTransferred(address indexed from, address indexed to);

    // -------------------------------------------------------------- errors

    error NotOwner();
    error NotAgent();
    error Reentrant();
    error KeepSealed();
    error CurtainNotListed(address target, bytes4 selector);
    error CurtainSelfCall();
    error CurtainUnlimitedApproval();
    error CurtainUnknownSpender(address spender);
    error DitchUncapped(address asset);
    error DitchPerTx(address asset, uint256 amount, uint256 cap);
    error DitchPerHour(address asset, uint256 wouldBe, uint256 cap);
    error DitchPerDay(address asset, uint256 wouldBe, uint256 cap);
    error GateUnknown(bytes32 id);
    error GateNotYet(bytes32 id, uint64 eta);
    error GateMismatch(bytes32 id);
    error CallFailed(bytes reason);
    error ZeroAddress();

    // ----------------------------------------------------------- modifiers

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier nonReentrant() {
        if (_lock != 1) revert Reentrant();
        _lock = 2;
        _;
        _lock = 1;
    }

    constructor(address owner_, address agent_, uint64 gateDelay_) {
        if (owner_ == address(0) || agent_ == address(0)) revert ZeroAddress();
        owner = owner_;
        agent = agent_;
        gateDelay = gateDelay_;
        emit OwnershipTransferred(address(0), owner_);
        emit AgentSet(agent_);
    }

    receive() external payable {}

    // ===================================================== agent entrypoints

    /// @notice Agent asks to make a call. Lands, is held at the gate, or reverts with the rampart that refused it.
    /// @return heldId Non-zero if the call was queued at the gate instead of sent.
    function execute(address target, uint256 value, bytes calldata data)
        external
        nonReentrant
        returns (bytes32 heldId, bytes memory ret)
    {
        if (msg.sender != agent) revert NotAgent();
        if (frozen) revert KeepSealed();
        _curtain(target, data);

        uint256 tokenAmt = _tokenMove(data);
        if (_overGate(address(0), value) || (tokenAmt != 0 && _overGate(target, tokenAmt))) {
            // Fail fast: don't queue something the ditch would refuse right now.
            if (value != 0) _checkCaps(address(0), value);
            if (tokenAmt != 0) _checkCaps(target, tokenAmt);
            heldId = keccak256(abi.encode(address(this), nonce++));
            uint64 eta = uint64(block.timestamp) + gateDelay;
            held[heldId] = Held(keccak256(abi.encode(target, value, data)), eta);
            emit HeldAtGate(heldId, target, value, data, eta);
            return (heldId, "");
        }

        ret = _land(target, value, data, tokenAmt, bytes32(0));
    }

    /// @notice Release a held call after its delay. Agent or owner. Keep, curtain and ditch are re-checked now.
    function release(bytes32 id, address target, uint256 value, bytes calldata data)
        external
        nonReentrant
        returns (bytes memory ret)
    {
        if (msg.sender != agent && msg.sender != owner) revert NotAgent();
        Held memory h = held[id];
        if (h.eta == 0) revert GateUnknown(id);
        if (h.callHash != keccak256(abi.encode(target, value, data))) revert GateMismatch(id);
        if (block.timestamp < h.eta) revert GateNotYet(id, h.eta);
        if (frozen) revert KeepSealed();
        _curtain(target, data);
        delete held[id];

        ret = _land(target, value, data, _tokenMove(data), id);
    }

    // ====================================================== owner controls

    function cancel(bytes32 id) external onlyOwner {
        if (held[id].eta == 0) revert GateUnknown(id);
        delete held[id];
        emit Cancelled(id);
    }

    function freeze() external onlyOwner {
        frozen = true;
        emit Frozen(true);
    }

    function unfreeze() external onlyOwner {
        frozen = false;
        emit Frozen(false);
    }

    function setAllowed(address target, bytes4[] calldata selectors, bool ok) external onlyOwner {
        if (target == address(this)) revert CurtainSelfCall();
        for (uint256 i; i < selectors.length; ++i) {
            if (allowed[target][selectors[i]] == ok) continue;
            allowed[target][selectors[i]] = ok;
            if (ok) ++allowedCount[target];
            else --allowedCount[target];
            emit Listed(target, selectors[i], ok);
        }
        _revise();
    }

    function setLimits(address asset, Limits calldata l) external onlyOwner {
        limits[asset] = l;
        emit LimitsSet(asset, l.set, l.perTx, l.perHour, l.perDay, l.holdAbove);
        _revise();
    }

    function setGateDelay(uint64 delay) external onlyOwner {
        gateDelay = delay;
        _revise();
    }

    function setAgent(address agent_) external onlyOwner {
        if (agent_ == address(0)) revert ZeroAddress();
        agent = agent_;
        emit AgentSet(agent_);
        _revise();
    }

    /// @notice Owner acts directly, outside the ramparts (withdrawals, rescue).
    function ownerExecute(address target, uint256 value, bytes calldata data)
        external
        onlyOwner
        nonReentrant
        returns (bytes memory ret)
    {
        bool ok;
        (ok, ret) = target.call{value: value}(data);
        if (!ok) revert CallFailed(ret);
    }

    function transferOwnership(address to) external onlyOwner {
        pendingOwner = to;
        emit OwnershipTransferStarted(owner, to);
    }

    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert NotOwner();
        emit OwnershipTransferred(owner, msg.sender);
        owner = msg.sender;
        pendingOwner = address(0);
    }

    // ============================================================== views

    /// @notice Dry-run a call without sending: returns 0 pass, 1 hold, or reverts with the refusing rampart.
    function rule(address target, uint256 value, bytes calldata data) external view returns (uint8) {
        if (frozen) revert KeepSealed();
        _curtain(target, data);
        uint256 tokenAmt = _tokenMove(data);
        if (value != 0) _checkCaps(address(0), value);
        if (tokenAmt != 0) _checkCaps(target, tokenAmt);
        if (_overGate(address(0), value) || (tokenAmt != 0 && _overGate(target, tokenAmt))) return 1;
        return 0;
    }

    // =========================================================== internals

    function _land(address target, uint256 value, bytes calldata data, uint256 tokenAmt, bytes32 heldId)
        private
        returns (bytes memory ret)
    {
        if (value != 0) _charge(address(0), value);
        if (tokenAmt != 0) _charge(target, tokenAmt);

        bool ok;
        (ok, ret) = target.call{value: value}(data);
        if (!ok) revert CallFailed(ret);
        emit Passed(target, _sel(data), value, heldId);
    }

    function _curtain(address target, bytes calldata data) private view {
        if (target == address(this)) revert CurtainSelfCall();
        bytes4 sel = _sel(data);
        if (!allowed[target][sel]) revert CurtainNotListed(target, sel);

        if (sel == APPROVE || sel == INCREASE_ALLOWANCE) {
            (address spender, uint256 amt) = abi.decode(data[4:], (address, uint256));
            if (amt == type(uint256).max) revert CurtainUnlimitedApproval();
            if (allowedCount[spender] == 0) revert CurtainUnknownSpender(spender);
        } else if (sel == SET_APPROVAL_FOR_ALL) {
            (, bool on) = abi.decode(data[4:], (address, bool));
            if (on) revert CurtainUnlimitedApproval();
        }
    }

    /// Token amount this calldata moves or authorises on `target`, if it is a known ERC-20 move.
    function _tokenMove(bytes calldata data) private pure returns (uint256 amt) {
        bytes4 sel = _sel(data);
        if (sel == TRANSFER || sel == APPROVE || sel == INCREASE_ALLOWANCE) {
            (, amt) = abi.decode(data[4:], (address, uint256));
        } else if (sel == TRANSFER_FROM) {
            (,, amt) = abi.decode(data[4:], (address, address, uint256));
        }
    }

    function _overGate(address asset, uint256 amount) private view returns (bool) {
        uint128 h = limits[asset].holdAbove;
        return h != 0 && amount > h;
    }

    function _checkCaps(address asset, uint256 amount) private view returns (uint128 hourNext, uint128 dayNext) {
        Limits memory l = limits[asset];
        if (!l.set) revert DitchUncapped(asset);
        if (amount > l.perTx) revert DitchPerTx(asset, amount, l.perTx);

        Spend memory s = spent[asset];
        uint64 h = uint64(block.timestamp / 1 hours);
        uint64 d = uint64(block.timestamp / 1 days);
        uint256 hourWould = (s.hourEpoch == h ? s.hourSpent : 0) + amount;
        uint256 dayWould = (s.dayEpoch == d ? s.daySpent : 0) + amount;
        if (hourWould > l.perHour) revert DitchPerHour(asset, hourWould, l.perHour);
        if (dayWould > l.perDay) revert DitchPerDay(asset, dayWould, l.perDay);
        return (uint128(hourWould), uint128(dayWould));
    }

    function _charge(address asset, uint256 amount) private {
        (uint128 hourNext, uint128 dayNext) = _checkCaps(asset, amount);
        spent[asset] = Spend(uint64(block.timestamp / 1 hours), uint64(block.timestamp / 1 days), hourNext, dayNext);
    }

    function _sel(bytes calldata data) private pure returns (bytes4 s) {
        if (data.length == 0) return PLAIN;
        // 1–3 byte calldata hits fallbacks; treat it as an unlistable selector.
        if (data.length < 4) return 0xffffffff;
        s = bytes4(data[:4]);
        // Zero-prefixed calldata must not ride on a plain-send listing into a fallback.
        if (s == PLAIN) return 0xffffffff;
    }

    function _revise() private {
        emit PolicyRevised(++revision);
    }
}

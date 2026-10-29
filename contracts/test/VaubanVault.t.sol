// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {VaubanVault} from "../src/VaubanVault.sol";
import {MockToken, MockRouter, Reenterer} from "./mocks/Mocks.sol";

contract VaubanVaultTest is Test {
    VaubanVault v;
    MockToken usdg;
    MockRouter router;

    address owner = makeAddr("owner");
    address agent = makeAddr("agent");
    address treasury = makeAddr("treasury");
    address stranger = makeAddr("stranger");

    uint64 constant DELAY = 6 hours;

    function setUp() public {
        vm.warp(1_800_000_000);
        v = new VaubanVault(owner, agent, DELAY);
        usdg = new MockToken();
        router = new MockRouter();
        vm.deal(address(v), 10 ether);
        usdg.mint(address(v), 1_000_000e18);

        vm.startPrank(owner);
        v.setAllowed(address(router), _sels(MockRouter.buy.selector, MockRouter.sell.selector), true);
        v.setAllowed(address(usdg), _sels(MockToken.transfer.selector, MockToken.approve.selector), true);
        v.setAllowed(treasury, _sels(bytes4(0)), true);
        v.setLimits(address(0), _lim(0.1 ether, 0.3 ether, 1 ether, 0.05 ether));
        v.setLimits(address(usdg), _lim(500e18, 1_000e18, 2_000e18, 0));
        vm.stopPrank();
    }

    // ------------------------------------------------------------- helpers

    function _sels(bytes4 a) internal pure returns (bytes4[] memory s) {
        s = new bytes4[](1);
        s[0] = a;
    }

    function _sels(bytes4 a, bytes4 b) internal pure returns (bytes4[] memory s) {
        s = new bytes4[](2);
        s[0] = a;
        s[1] = b;
    }

    function _lim(uint128 tx_, uint128 hr, uint128 day, uint128 hold) internal pure returns (VaubanVault.Limits memory) {
        return VaubanVault.Limits(true, tx_, hr, day, hold);
    }

    function _buy(uint256 amt) internal returns (bytes32 id) {
        vm.prank(agent);
        (id,) = v.execute(address(router), amt, abi.encodeCall(MockRouter.buy, ()));
    }

    // ================================================================ PASS

    function test_pass_smallBuy() public {
        bytes32 id = _buy(0.04 ether);
        assertEq(id, bytes32(0));
        assertEq(router.buys(), 0.04 ether);
    }

    function test_pass_tokenTransferUnderCap() public {
        vm.prank(agent);
        v.execute(address(usdg), 0, abi.encodeCall(MockToken.transfer, (treasury, 120e18)));
        assertEq(usdg.balanceOf(treasury), 120e18);
    }

    function test_pass_boundedApproveThenSell() public {
        vm.startPrank(agent);
        v.execute(address(usdg), 0, abi.encodeCall(MockToken.approve, (address(router), 300e18)));
        // sell itself moves no value the vault can decode; the approve above was charged instead
        v.execute(address(router), 0, abi.encodeCall(MockRouter.sell, (usdg, 300e18)));
        vm.stopPrank();
        assertEq(usdg.balanceOf(address(router)), 300e18);
        (,,, uint128 daySpent) = v.spent(address(usdg));
        assertEq(daySpent, 300e18);
    }

    // ============================================================== CURTAIN

    function test_curtain_unknownContract() public {
        address evil = makeAddr("evil");
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(VaubanVault.CurtainNotListed.selector, evil, bytes4(0)));
        v.execute(evil, 0.01 ether, "");
    }

    function test_curtain_unlistedFunctionOnListedContract() public {
        bytes memory data = abi.encodeCall(MockToken.transferFrom, (address(v), stranger, 1));
        vm.prank(agent);
        vm.expectRevert(
            abi.encodeWithSelector(VaubanVault.CurtainNotListed.selector, address(usdg), MockToken.transferFrom.selector)
        );
        v.execute(address(usdg), 0, data);
    }

    function test_curtain_unlimitedApprove() public {
        vm.prank(agent);
        vm.expectRevert(VaubanVault.CurtainUnlimitedApproval.selector);
        v.execute(address(usdg), 0, abi.encodeCall(MockToken.approve, (address(router), type(uint256).max)));
    }

    function test_curtain_approveToUnknownSpender() public {
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(VaubanVault.CurtainUnknownSpender.selector, stranger));
        v.execute(address(usdg), 0, abi.encodeCall(MockToken.approve, (stranger, 1e18)));
    }

    function test_curtain_selfCallBlocked() public {
        vm.prank(agent);
        vm.expectRevert(VaubanVault.CurtainSelfCall.selector);
        v.execute(address(v), 0, abi.encodeCall(VaubanVault.unfreeze, ()));

        vm.prank(owner);
        vm.expectRevert(VaubanVault.CurtainSelfCall.selector);
        v.setAllowed(address(v), _sels(VaubanVault.unfreeze.selector), true);
    }

    function test_curtain_shortCalldataNotPlainSend() public {
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(VaubanVault.CurtainNotListed.selector, treasury, bytes4(0xffffffff)));
        v.execute(treasury, 0.01 ether, hex"aa");
    }

    function test_curtain_zeroSelectorNotPlainSend() public {
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(VaubanVault.CurtainNotListed.selector, treasury, bytes4(0xffffffff)));
        v.execute(treasury, 0.01 ether, hex"00000000deadbeef");
    }

    // ================================================================ DITCH

    function test_ditch_perTx() public {
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(VaubanVault.DitchPerTx.selector, address(0), 0.2 ether, 0.1 ether));
        v.execute(address(router), 0.2 ether, abi.encodeCall(MockRouter.buy, ()));
    }

    function test_ditch_runawayLoopStopsAtHourCap() public {
        // 0.04 ETH per tick; hour cap 0.3 -> 7 pass, 8th refused
        for (uint256 i; i < 7; ++i) _buy(0.04 ether);
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(VaubanVault.DitchPerHour.selector, address(0), 0.32 ether, 0.3 ether));
        v.execute(address(router), 0.04 ether, abi.encodeCall(MockRouter.buy, ()));
        assertEq(router.buys(), 0.28 ether);
    }

    function test_ditch_hourRollsButDayHolds() public {
        uint256 total;
        // 0.04 x 7 per hour, 0.28/h; day cap 1.0 -> fourth hour hits day cap
        for (uint256 h; h < 4; ++h) {
            for (uint256 i; i < 7; ++i) {
                vm.prank(agent);
                try v.execute(address(router), 0.04 ether, abi.encodeCall(MockRouter.buy, ())) {
                    total += 0.04 ether;
                } catch {}
            }
            vm.warp(block.timestamp + 1 hours);
        }
        assertLe(total, 1 ether);
        assertEq(router.buys(), total);
    }

    function test_ditch_uncappedAssetRefused() public {
        MockToken other = new MockToken();
        other.mint(address(v), 1e18);
        vm.prank(owner);
        v.setAllowed(address(other), _sels(MockToken.transfer.selector), true);
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(VaubanVault.DitchUncapped.selector, address(other)));
        v.execute(address(other), 0, abi.encodeCall(MockToken.transfer, (treasury, 1)));
    }

    function test_ditch_approveCountsAgainstTokenCap() public {
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(VaubanVault.DitchPerTx.selector, address(usdg), 600e18, 500e18));
        v.execute(address(usdg), 0, abi.encodeCall(MockToken.approve, (address(router), 600e18)));
    }

    // ================================================================= GATE

    function test_gate_holdsThenReleases() public {
        bytes memory data = abi.encodeCall(MockRouter.buy, ());
        bytes32 id = _buy(0.08 ether);
        assertTrue(id != bytes32(0));
        assertEq(router.buys(), 0);

        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(VaubanVault.GateNotYet.selector, id, uint64(block.timestamp + DELAY)));
        v.release(id, address(router), 0.08 ether, data);

        vm.warp(block.timestamp + DELAY);
        vm.prank(agent);
        v.release(id, address(router), 0.08 ether, data);
        assertEq(router.buys(), 0.08 ether);

        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(VaubanVault.GateUnknown.selector, id));
        v.release(id, address(router), 0.08 ether, data);
    }

    function test_gate_ownerCancels() public {
        bytes32 id = _buy(0.08 ether);
        vm.prank(owner);
        v.cancel(id);
        vm.warp(block.timestamp + DELAY);
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(VaubanVault.GateUnknown.selector, id));
        v.release(id, address(router), 0.08 ether, abi.encodeCall(MockRouter.buy, ()));
    }

    function test_gate_cannotSwapPayload() public {
        bytes32 id = _buy(0.08 ether);
        vm.warp(block.timestamp + DELAY);
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(VaubanVault.GateMismatch.selector, id));
        v.release(id, treasury, 0.08 ether, "");
    }

    function test_gate_rechecksCurtainOnRelease() public {
        bytes32 id = _buy(0.08 ether);
        vm.prank(owner);
        v.setAllowed(address(router), _sels(MockRouter.buy.selector), false);
        vm.warp(block.timestamp + DELAY);
        vm.prank(agent);
        vm.expectRevert(
            abi.encodeWithSelector(VaubanVault.CurtainNotListed.selector, address(router), MockRouter.buy.selector)
        );
        v.release(id, address(router), 0.08 ether, abi.encodeCall(MockRouter.buy, ()));
    }

    function test_gate_doesNotQueueWhatDitchRefuses() public {
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(VaubanVault.DitchPerTx.selector, address(0), 0.5 ether, 0.1 ether));
        v.execute(address(router), 0.5 ether, abi.encodeCall(MockRouter.buy, ()));
    }

    function test_gate_strangerCannotRelease() public {
        bytes32 id = _buy(0.08 ether);
        vm.warp(block.timestamp + DELAY);
        vm.prank(stranger);
        vm.expectRevert(VaubanVault.NotAgent.selector);
        v.release(id, address(router), 0.08 ether, abi.encodeCall(MockRouter.buy, ()));
    }

    // ================================================================= KEEP

    function test_keep_freezeStopsEverything() public {
        bytes32 id = _buy(0.08 ether);
        vm.prank(owner);
        v.freeze();

        vm.prank(agent);
        vm.expectRevert(VaubanVault.KeepSealed.selector);
        v.execute(address(router), 0.01 ether, abi.encodeCall(MockRouter.buy, ()));

        vm.warp(block.timestamp + DELAY);
        vm.prank(agent);
        vm.expectRevert(VaubanVault.KeepSealed.selector);
        v.release(id, address(router), 0.08 ether, abi.encodeCall(MockRouter.buy, ()));
    }

    function test_keep_agentCannotUnfreezeOrRewrite() public {
        vm.prank(owner);
        v.freeze();
        vm.startPrank(agent);
        vm.expectRevert(VaubanVault.NotOwner.selector);
        v.unfreeze();
        vm.expectRevert(VaubanVault.NotOwner.selector);
        v.setLimits(address(0), _lim(100 ether, 100 ether, 100 ether, 0));
        vm.expectRevert(VaubanVault.NotOwner.selector);
        v.setAllowed(stranger, _sels(bytes4(0)), true);
        vm.expectRevert(VaubanVault.NotOwner.selector);
        v.setAgent(stranger);
        vm.expectRevert(VaubanVault.NotOwner.selector);
        v.transferOwnership(agent);
        vm.expectRevert(VaubanVault.NotOwner.selector);
        v.ownerExecute(stranger, 1 ether, "");
        vm.stopPrank();
    }

    function test_keep_ownerCanWithdrawWhileFrozen() public {
        vm.startPrank(owner);
        v.freeze();
        v.ownerExecute(owner, 10 ether, "");
        vm.stopPrank();
        assertEq(owner.balance, 10 ether);
    }

    // ================================================================ OTHER

    function test_onlyAgentExecutes() public {
        vm.prank(stranger);
        vm.expectRevert(VaubanVault.NotAgent.selector);
        v.execute(address(router), 0.01 ether, abi.encodeCall(MockRouter.buy, ()));
    }

    function test_reentrancyBlocked() public {
        Reenterer r = new Reenterer();
        r.arm(address(v), abi.encodeCall(VaubanVault.execute, (treasury, 0.05 ether, "")));
        vm.prank(owner);
        v.setAllowed(address(r), _sels(Reenterer.poke.selector), true);
        vm.prank(agent);
        vm.expectRevert(); // CallFailed(Reentrant)
        v.execute(address(r), 0, abi.encodeCall(Reenterer.poke, ()));
    }

    function test_twoStepOwnership() public {
        vm.prank(owner);
        v.transferOwnership(stranger);
        assertEq(v.owner(), owner);
        vm.prank(agent);
        vm.expectRevert(VaubanVault.NotOwner.selector);
        v.acceptOwnership();
        vm.prank(stranger);
        v.acceptOwnership();
        assertEq(v.owner(), stranger);
    }

    function test_revisionIncrements() public {
        uint64 r = v.revision();
        vm.prank(owner);
        v.setGateDelay(1 hours);
        assertEq(v.revision(), r + 1);
    }

    /// The whole sheet can be rebuilt from logs alone: every listing and every limit is emitted.
    function test_policyIsLogged() public {
        bytes4 sel = MockRouter.buy.selector;
        vm.expectEmit(true, true, false, true, address(v));
        emit VaubanVault.Listed(address(router), sel, false);
        vm.prank(owner);
        v.setAllowed(address(router), _sels(sel), false);

        vm.expectEmit(true, false, false, true, address(v));
        emit VaubanVault.LimitsSet(address(usdg), true, 1, 2, 3, 0);
        vm.prank(owner);
        v.setLimits(address(usdg), _lim(1, 2, 3, 0));

        // A no-op listing changes nothing, so it logs nothing.
        vm.recordLogs();
        vm.prank(owner);
        v.setAllowed(address(router), _sels(sel), false);
        assertEq(vm.getRecordedLogs().length, 1); // PolicyRevised only
    }

    function test_ruleDryRun() public view {
        bytes memory buy = abi.encodeCall(MockRouter.buy, ());
        assertEq(v.rule(address(router), 0.04 ether, buy), 0);
        assertEq(v.rule(address(router), 0.08 ether, buy), 1);
    }

    // ================================================================= FUZZ

    /// Whatever the agent sends, ETH out per day never exceeds the day cap.
    function testFuzz_dayCapNeverExceeded(uint96[24] calldata amts) public {
        uint256 start = address(v).balance;
        for (uint256 i; i < amts.length; ++i) {
            vm.prank(agent);
            try v.execute(treasury, uint256(amts[i]) % 0.12 ether, "") {} catch {}
            vm.warp(block.timestamp + 40 minutes);
        }
        // 24 ticks x 40 min = 16h, all inside at most two day-buckets
        assertLe(start - address(v).balance, 2 ether);
        (,,, uint128 daySpent) = v.spent(address(0));
        assertLe(daySpent, 1 ether);
    }

    /// No calldata the agent sends to an unlisted target ever lands.
    function testFuzz_unlistedTargetNeverLands(address target, uint256 value, bytes calldata data) public {
        vm.assume(target != address(router) && target != address(usdg) && target != treasury);
        value = bound(value, 0, 0.05 ether);
        uint256 start = address(v).balance;
        vm.prank(agent);
        try v.execute(target, value, data) {
            fail();
        } catch {}
        assertEq(address(v).balance, start);
    }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {VaubanVault} from "../src/VaubanVault.sol";

/// Deploys an empty vault: no targets listed, no assets capped, so nothing can move until the owner draws the sheet.
/// env: VAUBAN_OWNER, VAUBAN_AGENT, VAUBAN_GATE_DELAY (seconds, default 6h)
contract Deploy is Script {
    function run() external returns (VaubanVault v) {
        address owner = vm.envAddress("VAUBAN_OWNER");
        address agent = vm.envAddress("VAUBAN_AGENT");
        uint64 delay = uint64(vm.envOr("VAUBAN_GATE_DELAY", uint256(6 hours)));
        require(owner != agent, "owner must not be the agent");

        vm.startBroadcast();
        v = new VaubanVault(owner, agent, delay);
        vm.stopBroadcast();

        console2.log("VaubanVault", address(v));
        console2.log("owner", owner);
        console2.log("agent", agent);
        console2.log("gateDelay", delay);
    }
}

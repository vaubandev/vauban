// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract MockToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amt) external {
        balanceOf[to] += amt;
    }

    function transfer(address to, uint256 amt) external returns (bool) {
        balanceOf[msg.sender] -= amt;
        balanceOf[to] += amt;
        return true;
    }

    function approve(address spender, uint256 amt) external returns (bool) {
        allowance[msg.sender][spender] = amt;
        return true;
    }

    function transferFrom(address from, address to, uint256 amt) external returns (bool) {
        allowance[from][msg.sender] -= amt;
        balanceOf[from] -= amt;
        balanceOf[to] += amt;
        return true;
    }
}

/// Stand-in for a DEX router: takes ETH on buy, pulls tokens on sell.
contract MockRouter {
    uint256 public buys;

    function buy() external payable {
        buys += msg.value;
    }

    function sell(MockToken t, uint256 amt) external {
        t.transferFrom(msg.sender, address(this), amt);
    }
}

/// Tries to re-enter the vault during a call.
contract Reenterer {
    address public vault;
    bytes public payload;

    function arm(address v, bytes calldata p) external {
        vault = v;
        payload = p;
    }

    function poke() external payable {
        (bool ok, bytes memory ret) = vault.call(payload);
        if (!ok) {
            assembly {
                revert(add(ret, 32), mload(ret))
            }
        }
    }
}

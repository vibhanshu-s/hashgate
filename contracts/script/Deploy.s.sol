// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {Hashgate, IERC20} from "../src/Hashgate.sol";

/// forge script script/Deploy.s.sol --rpc-url aevum --broadcast --legacy --account <keystore>
contract Deploy is Script {
    address constant TUSD8 = 0x456569838f1d43009A91ebA4263147Afd7233483;

    function run() external {
        vm.startBroadcast();
        Hashgate hg = new Hashgate(IERC20(TUSD8));
        vm.stopBroadcast();
        console.log("Hashgate", address(hg));
    }
}

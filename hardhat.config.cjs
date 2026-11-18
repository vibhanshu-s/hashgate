// Only used for the in-process EVM in packages/sdk tests (Foundry runs in CI).
module.exports = { solidity: "0.8.24", networks: { hardhat: { hardfork: "shanghai", chainId: 31337, allowUnlimitedContractSize: false } } };

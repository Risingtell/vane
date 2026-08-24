import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-ethers";
import "@nomicfoundation/hardhat-chai-matchers";
import * as fs from "fs";
import "dotenv/config";

// Throwaway deploy key, never committed. See .gitignore.
function loadDeployerKey(): string[] {
  const envKey = process.env.PRIVATE_KEY;
  if (envKey) return [envKey];
  const path = ".throwaway-key.local";
  if (fs.existsSync(path)) return [fs.readFileSync(path, "utf8").trim()];
  return [];
}

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.25",
    settings: {
      evmVersion: "paris",
      optimizer: { enabled: true, runs: 200 },
    },
  },
  networks: {
    // Somnia Shannon testnet. Reactivity is testnet only, so this is the only
    // network Vane can run on, and it is also what the hackathon requires.
    shannon: {
      url: process.env.SHANNON_RPC_URL ?? "https://dream-rpc.somnia.network",
      accounts: loadDeployerKey(),
      chainId: 50312,
    },
  },
  paths: { sources: "./contracts/", tests: "./test/", cache: "./cache", artifacts: "./artifacts" },
};

export default config;

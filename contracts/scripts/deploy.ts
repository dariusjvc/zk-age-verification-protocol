/**
 * contracts/scripts/deploy.ts
 * Deploys all contracts in dependency order and saves addresses to a JSON file.
 *
 * Usage:
 *   npx hardhat run scripts/deploy.ts --network localhost
 *   npx hardhat run scripts/deploy.ts --network sepolia
 */

import { ethers } from "hardhat";
import fs from "fs";
import path from "path";

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deploying contracts with account:", deployer.address);
  console.log("Account balance:", ethers.formatEther(await deployer.provider.getBalance(deployer.address)), "ETH\n");

  // ── 1. IssuerRegistry ────────────────────────────────────────────
  console.log("==> Deploying IssuerRegistry...");
  const IssuerRegistry = await ethers.getContractFactory("IssuerRegistry");
  const issuerRegistry = await IssuerRegistry.deploy();
  await issuerRegistry.waitForDeployment();
  const issuerRegistryAddr = await issuerRegistry.getAddress();
  console.log("    IssuerRegistry deployed at:", issuerRegistryAddr);

  // ── 2. CommitmentRegistry ────────────────────────────────────────
  console.log("==> Deploying CommitmentRegistry...");
  const CommitmentRegistry = await ethers.getContractFactory("CommitmentRegistry");
  const commitmentRegistry = await CommitmentRegistry.deploy(issuerRegistryAddr);
  await commitmentRegistry.waitForDeployment();
  const commitmentRegistryAddr = await commitmentRegistry.getAddress();
  console.log("    CommitmentRegistry deployed at:", commitmentRegistryAddr);

  // ── 3. AgeVerifier ───────────────────────────────────────────────
  console.log("==> Deploying AgeVerifier...");
  const AgeVerifier = await ethers.getContractFactory("AgeVerifier");
  const ageVerifier = await AgeVerifier.deploy();
  await ageVerifier.waitForDeployment();
  const ageVerifierAddr = await ageVerifier.getAddress();
  console.log("    AgeVerifier deployed at:", ageVerifierAddr);

  // ── 4. AgeRegistry ───────────────────────────────────────────────
  console.log("==> Deploying AgeRegistry...");
  const AgeRegistry = await ethers.getContractFactory("AgeRegistry");
  const ageRegistry = await AgeRegistry.deploy(ageVerifierAddr, commitmentRegistryAddr);
  await ageRegistry.waitForDeployment();
  const ageRegistryAddr = await ageRegistry.getAddress();
  console.log("    AgeRegistry deployed at:", ageRegistryAddr);

  // ── Save addresses ────────────────────────────────────────────────
  const addresses = {
    network:            (await ethers.provider.getNetwork()).name,
    chainId:            Number((await ethers.provider.getNetwork()).chainId),
    deployedAt:         new Date().toISOString(),
    deployer:           deployer.address,
    IssuerRegistry:     issuerRegistryAddr,
    CommitmentRegistry: commitmentRegistryAddr,
    AgeVerifier:        ageVerifierAddr,
    AgeRegistry:        ageRegistryAddr,
  };

  const outputPath = path.join(__dirname, "..", "deployment-addresses.json");
  fs.writeFileSync(outputPath, JSON.stringify(addresses, null, 2));
  console.log("\n==> Deployment addresses saved to:", outputPath);
  console.log(JSON.stringify(addresses, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

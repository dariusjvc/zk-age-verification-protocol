/**
 * contracts/scripts/deploy.js
 * Deploys all contracts in dependency order and saves addresses to JSON.
 *
 * Usage:
 *   npx hardhat run scripts/deploy.js --network localhost
 *   npx hardhat run scripts/deploy.js --network blockchainLocal
 *   npx hardhat run scripts/deploy.js --network sepolia
 */

const { ethers } = require("hardhat");
const fs = require("fs");
const path = require("path");

function upsertEnvVar(envText, key, value) {
  const line = `${key}=${value}`;
  const regex = new RegExp(`^${key}=.*$`, "m");
  if (regex.test(envText)) {
    return envText.replace(regex, line);
  }
  const suffix = envText.endsWith("\n") ? "" : "\n";
  return `${envText}${suffix}${line}\n`;
}

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deploying contracts with account:", deployer.address);
  console.log(
    "Account balance:",
    ethers.formatEther(await deployer.provider.getBalance(deployer.address)),
    "ETH\n"
  );

  console.log("==> Deploying IssuerRegistry...");
  const IssuerRegistry = await ethers.getContractFactory("IssuerRegistry");
  const issuerRegistry = await IssuerRegistry.deploy();
  await issuerRegistry.waitForDeployment();
  const issuerRegistryAddr = await issuerRegistry.getAddress();
  console.log("    IssuerRegistry deployed at:", issuerRegistryAddr);

  console.log("==> Deploying CommitmentRegistry...");
  const CommitmentRegistry = await ethers.getContractFactory("CommitmentRegistry");
  const commitmentRegistry = await CommitmentRegistry.deploy(issuerRegistryAddr);
  await commitmentRegistry.waitForDeployment();
  const commitmentRegistryAddr = await commitmentRegistry.getAddress();
  console.log("    CommitmentRegistry deployed at:", commitmentRegistryAddr);

  // ── Register backend issuer in IssuerRegistry ────────────────────
  // The issuer address is derived from ISSUER_PRIVATE_KEY in .env.
  // This allows CommitmentRegistry to accept signatures from the backend.
  const issuerPrivKey = process.env.ISSUER_PRIVATE_KEY;
  if (issuerPrivKey) {
    const issuerWallet = new ethers.Wallet(issuerPrivKey);
    const issuerAddress = issuerWallet.address;
    const chainId = Number((await ethers.provider.getNetwork()).chainId);
    const issuerDid = `did:ethr:${chainId}:${issuerAddress.toLowerCase()}`;
    console.log("==> Registering issuer in IssuerRegistry...");
    console.log("    Issuer address:", issuerAddress);
    console.log("    Issuer DID:    ", issuerDid);
    const tx = await issuerRegistry.registerIssuer(issuerDid, issuerAddress, "VC Age Issuer");
    await tx.wait();
    console.log("    Issuer registered.\n");
  } else {
    console.warn("WARNING: ISSUER_PRIVATE_KEY not set — skipping issuer registration.");
    console.warn("         CommitmentRegistry calls will fail until an issuer is registered.\n");
  }

  console.log("==> Deploying AgeVerifier...");
  const AgeVerifier = await ethers.getContractFactory("AgeVerifier");
  const ageVerifier = await AgeVerifier.deploy();
  await ageVerifier.waitForDeployment();
  const ageVerifierAddr = await ageVerifier.getAddress();
  console.log("    AgeVerifier deployed at:", ageVerifierAddr);

  console.log("==> Deploying AgeRegistry...");
  const AgeRegistry = await ethers.getContractFactory("AgeRegistry");
  const ageRegistry = await AgeRegistry.deploy(ageVerifierAddr, commitmentRegistryAddr);
  await ageRegistry.waitForDeployment();
  const ageRegistryAddr = await ageRegistry.getAddress();
  console.log("    AgeRegistry deployed at:", ageRegistryAddr);

  const network = await ethers.provider.getNetwork();
  const addresses = {
    network: network.name,
    chainId: Number(network.chainId),
    deployedAt: new Date().toISOString(),
    deployer: deployer.address,
    IssuerRegistry: issuerRegistryAddr,
    CommitmentRegistry: commitmentRegistryAddr,
    AgeVerifier: ageVerifierAddr,
    AgeRegistry: ageRegistryAddr,
  };

  const outputPath = path.join(__dirname, "..", "deployment-addresses.json");
  fs.writeFileSync(outputPath, JSON.stringify(addresses, null, 2));

  // Keep backend/frontend .env in sync with latest deployment addresses.
  const envPath = path.join(__dirname, "..", "..", ".env");
  let envText = "";
  if (fs.existsSync(envPath)) {
    envText = fs.readFileSync(envPath, "utf8");
  }

  envText = upsertEnvVar(envText, "COMMITMENT_REGISTRY_ADDRESS", addresses.CommitmentRegistry);
  envText = upsertEnvVar(envText, "AGE_REGISTRY_ADDRESS", addresses.AgeRegistry);
  envText = upsertEnvVar(envText, "VITE_COMMITMENT_REGISTRY_ADDRESS", addresses.CommitmentRegistry);
  envText = upsertEnvVar(envText, "VITE_AGE_REGISTRY_ADDRESS", addresses.AgeRegistry);

  fs.writeFileSync(envPath, envText);

  console.log("\n==> Deployment addresses saved to:", outputPath);
  console.log("==> .env updated at:", envPath);
  console.log(JSON.stringify(addresses, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

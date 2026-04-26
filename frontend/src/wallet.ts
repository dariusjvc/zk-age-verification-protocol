/**
 * frontend/src/wallet.ts
 * MetaMask / EIP-1193 wallet connection and Ethereum interaction.
 */

import { ethers, type BrowserProvider, type Signer } from "ethers";

let _provider: BrowserProvider | null = null;
let _signer: Signer | null = null;

// ─── ABI fragment for AgeRegistry ─────────────────────────────────────
const AGE_REGISTRY_ABI = [
  "function verifyAge(uint256[2] a, uint256[2][2] b, uint256[2] c, uint256 currentTimestamp, uint256 nullifier) external",
  "function isVerified(address user) external view returns (bool)",
  "function getVerificationExpiry(address user) external view returns (uint256)",
  "event AgeVerified(address indexed user, uint256 indexed nullifier, uint256 expiresAt)",
];

const COMMITMENT_REGISTRY_ABI = [
  "function registerCommitment(uint256 commitment, bytes calldata issuerSignature) external",
  "function revokeCommitment() external",
  "function getCommitment(address user) external view returns (uint256)",
];

// ─── Connection ────────────────────────────────────────────────────────

/**
 * Connects to MetaMask and returns the user's Ethereum address.
 * Throws if MetaMask is not installed or the user rejects.
 */
export async function connectWallet(): Promise<string> {
  if (!window.ethereum) {
    throw new Error("MetaMask not detected. Please install MetaMask.");
  }

  _provider = new ethers.BrowserProvider(window.ethereum);

  // eth_requestAccounts triggers the MetaMask popup
  await _provider.send("eth_requestAccounts", []);
  _signer = await _provider.getSigner();

  return _signer.getAddress();
}

export async function getSigner(): Promise<Signer> {
  if (!_signer) throw new Error("Wallet not connected");
  return _signer;
}

export async function getAddress(): Promise<string> {
  const signer = await getSigner();
  return signer.getAddress();
}

export async function getChainId(): Promise<number> {
  if (!_provider) throw new Error("Wallet not connected");
  const network = await _provider.getNetwork();
  return Number(network.chainId);
}

// ─── Contract interactions ─────────────────────────────────────────────

/**
 * Returns the active commitment for a user, or 0n if none.
 */
export async function getExistingCommitment(
  commitmentRegistryAddress: string,
  userAddress: string
): Promise<bigint> {
  if (!_provider) throw new Error("Wallet not connected");
  const contract = new ethers.Contract(
    commitmentRegistryAddress,
    COMMITMENT_REGISTRY_ABI,
    _provider
  );
  return BigInt(await contract.getCommitment(userAddress));
}

/**
 * Revokes the caller's existing commitment so a new one can be registered.
 */
export async function revokeCommitmentOnChain(
  commitmentRegistryAddress: string
): Promise<void> {
  const signer = await getSigner();
  const contract = new ethers.Contract(
    commitmentRegistryAddress,
    COMMITMENT_REGISTRY_ABI,
    signer
  );
  const tx = await contract.revokeCommitment();
  await tx.wait();
}

/**
 * Registers a Poseidon commitment on CommitmentRegistry using the issuer's signature.
 */
export async function registerCommitmentOnChain(
  commitmentRegistryAddress: string,
  commitment: bigint,
  issuerSignature: string
): Promise<string> {
  const signer = await getSigner();
  const contract = new ethers.Contract(
    commitmentRegistryAddress,
    COMMITMENT_REGISTRY_ABI,
    signer
  );
  const tx = await contract.registerCommitment(commitment, issuerSignature);
  const receipt = await tx.wait();
  return receipt.hash as string;
}

/**
 * Submits a ZK proof to AgeRegistry.verifyAge().
 */
export async function submitAgeProof(
  ageRegistryAddress: string,
  proofA: [bigint, bigint],
  proofB: [[bigint, bigint], [bigint, bigint]],
  proofC: [bigint, bigint],
  currentTimestamp: bigint,
  nullifier: bigint
): Promise<string> {
  const signer = await getSigner();
  const contract = new ethers.Contract(ageRegistryAddress, AGE_REGISTRY_ABI, signer);

  const tx = await contract.verifyAge(
    proofA,
    proofB,
    proofC,
    currentTimestamp,
    nullifier
  );
  const receipt = await tx.wait();
  return receipt.hash as string;
}

/**
 * Checks whether a user's age is currently verified on-chain.
 */
export async function checkVerificationStatus(
  ageRegistryAddress: string,
  userAddress: string
): Promise<{ verified: boolean; expiresAt?: Date }> {
  if (!_provider) throw new Error("Wallet not connected");
  const contract = new ethers.Contract(ageRegistryAddress, AGE_REGISTRY_ABI, _provider);
  const verified: boolean = await contract.isVerified(userAddress);
  if (!verified) return { verified: false };
  const expiryBigInt: bigint = await contract.getVerificationExpiry(userAddress);
  return { verified: true, expiresAt: new Date(Number(expiryBigInt) * 1000) };
}

// ─── TypeScript augmentation for window.ethereum ─────────────────────
declare global {
  interface Window {
    ethereum?: {
      request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
      on: (event: string, handler: (...args: unknown[]) => void) => void;
      removeListener: (event: string, handler: (...args: unknown[]) => void) => void;
      isMetaMask?: boolean;
    };
  }
}

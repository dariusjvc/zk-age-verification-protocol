/**
 * backend/src/issuer.ts
 * On-chain issuer logic:
 *   - Signs commitment messages for holders
 *   - Registers commitments on CommitmentRegistry
 */

import { ethers } from "ethers";
import type { IssuerConfig } from "./types.js";

// Minimal ABI — only the functions we need
const COMMITMENT_REGISTRY_ABI = [
  "function registerCommitment(uint256 commitment, bytes calldata issuerSignature) external",
  "function getCommitment(address user) external view returns (uint256)",
  "function commitmentExists(uint256 commitment) external view returns (bool)",
];

export class IssuerService {
  private wallet: ethers.Wallet;
  private provider: ethers.JsonRpcProvider;
  private commitmentRegistry: ethers.Contract;

  constructor(config: IssuerConfig) {
    this.provider = new ethers.JsonRpcProvider(config.rpcUrl);
    this.wallet = new ethers.Wallet(config.privateKey, this.provider);
    this.commitmentRegistry = new ethers.Contract(
      config.commitmentRegistryAddress,
      COMMITMENT_REGISTRY_ABI,
      this.wallet
    );
  }

  /**
   * Signs a commitment on behalf of a holder.
   *
   * The message is: keccak256(abi.encodePacked(holderAddress, commitment))
   * This is EIP-191 personal_sign, which matches what CommitmentRegistry._recoverIssuer expects.
   *
   * @param holderAddress Ethereum address of the credential holder
   * @param commitment    Poseidon(birthTimestamp, secret) as a BigInt or decimal string
   * @returns             ECDSA signature (65 bytes, hex)
   */
  async signCommitment(holderAddress: string, commitment: bigint): Promise<string> {
    // Validate holder address
    const checksumAddr = ethers.getAddress(holderAddress);

    // Reproduce the hash that CommitmentRegistry verifies on-chain:
    // keccak256(abi.encodePacked(holderAddress, commitment))
    const msgHash = ethers.solidityPackedKeccak256(
      ["address", "uint256"],
      [checksumAddr, commitment]
    );

    // EIP-191 personal sign (adds "\x19Ethereum Signed Message:\n32" prefix)
    const signature = await this.wallet.signMessage(ethers.getBytes(msgHash));
    return signature;
  }

  /**
   * Submits a commitment + issuer signature to CommitmentRegistry on-chain.
   * The holder address is the transaction sender (msg.sender in contract).
   *
   * Note: In production the HOLDER usually submits this tx themselves,
   * using the signature they received from the issuer. This method is
   * provided for convenience in development/testing.
   *
   * @param holderAddress Ethereum address of the holder (for logging only)
   * @param commitment    The commitment value
   * @param signature     Issuer's ECDSA signature
   */
  async registerCommitmentOnChain(
    commitment: bigint,
    signature: string
  ): Promise<string> {
    const tx = await this.commitmentRegistry.registerCommitment(commitment, signature);
    const receipt = await tx.wait();
    return receipt.hash as string;
  }

  /**
   * Returns the issuer's Ethereum address.
   */
  get address(): string {
    return this.wallet.address;
  }

  /**
   * Checks whether a commitment is already registered on-chain.
   */
  async isCommitmentRegistered(commitment: bigint): Promise<boolean> {
    return this.commitmentRegistry.commitmentExists(commitment);
  }
}

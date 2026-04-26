/**
 * backend/src/did.ts
 * DID utilities — creates and resolves Ethereum DIDs (did:ethr).
 */

import { EthrDID } from "ethr-did";
import { Resolver } from "did-resolver";
import { getResolver } from "ethr-did-resolver";
import { ethers } from "ethers";

// ─── Resolver (singleton) ─────────────────────────────────────────────

let _resolver: Resolver | null = null;

export function getDidResolver(rpcUrl: string, chainId: number): Resolver {
  if (_resolver) return _resolver;

  const providerConfig = {
    networks: [
      {
        name: chainId === 1 ? "mainnet" : chainId === 11155111 ? "sepolia" : "dev",
        chainId,
        rpcUrl,
      },
    ],
  };

  const ethrResolver = getResolver(providerConfig);
  _resolver = new Resolver({ ...ethrResolver });
  return _resolver;
}

// ─── DID creation ─────────────────────────────────────────────────────

/**
 * Creates an EthrDID instance from a private key.
 * @param privateKey  Ethereum private key (hex with or without 0x prefix)
 * @param chainId     Chain ID (1=mainnet, 11155111=sepolia, 31337=hardhat)
 * @param rpcUrl      RPC endpoint for signing transactions
 */
export function createIssuerDID(
  privateKey: string,
  chainId: number,
  rpcUrl: string
): { did: EthrDID; address: string; didString: string } {
  const wallet = new ethers.Wallet(privateKey);
  const address = wallet.address;

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const signer = wallet.connect(provider);

  const did = new EthrDID({
    identifier: address,
    privateKey: privateKey.replace(/^0x/, ""),
    provider,
    chainNameOrId: chainId,
  });

  const networkName =
    chainId === 1
      ? "mainnet"
      : chainId === 11155111
      ? "sepolia"
      : chainId.toString();

  const didString = `did:ethr:${networkName}:${address.toLowerCase()}`;

  return { did, address, didString };
}

/**
 * Parses a DID string and returns the embedded Ethereum address.
 * Supports: did:ethr:<network>:<address>  or  did:ethr:<address>
 */
export function extractAddressFromDID(did: string): string | null {
  // did:ethr:[network:]0x<address>
  const match = did.match(/did:ethr:(?:[^:]+:)?(0x[0-9a-fA-F]{40})$/);
  if (!match) return null;
  return ethers.getAddress(match[1]); // checksum address
}

/**
 * Validates a DID string format.
 */
export function isValidDID(did: string): boolean {
  return /^did:[a-z]+:[a-zA-Z0-9._:%-]+$/.test(did) && did.length < 256;
}

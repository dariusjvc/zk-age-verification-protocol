import test from "node:test";
import assert from "node:assert/strict";
import { ethers } from "ethers";

import { createIssuerDID, extractAddressFromDID, isValidDID } from "../src/did.js";
import { IssuerService } from "../src/issuer.js";

const TEST_PRIVATE_KEY = "0x59c6995e998f97a5a0044976f0945382db4f4c8d2f6d4c4e5f74b6d33f489f21";

test("createIssuerDID derives address and network-aware DID string", () => {
  const { address, didString } = createIssuerDID(
    TEST_PRIVATE_KEY,
    11155111,
    "http://127.0.0.1:8545"
  );

  assert.equal(didString, `did:ethr:sepolia:${address.toLowerCase()}`);
  assert.equal(address, new ethers.Wallet(TEST_PRIVATE_KEY).address);
});

test("extractAddressFromDID returns a checksummed address", () => {
  const wallet = new ethers.Wallet(TEST_PRIVATE_KEY);
  const extracted = extractAddressFromDID(`did:ethr:900:${wallet.address.toLowerCase()}`);

  assert.equal(extracted, wallet.address);
});

test("isValidDID rejects malformed identifiers", () => {
  assert.equal(isValidDID("did:ethr:900:0x1234"), true);
  assert.equal(isValidDID("did:ethr:bad value"), false);
  assert.equal(isValidDID("not-a-did"), false);
});

test("IssuerService.signCommitment signs the same digest expected on-chain", async () => {
  const service = new IssuerService({
    privateKey: TEST_PRIVATE_KEY,
    did: "did:ethr:900:test",
    address: new ethers.Wallet(TEST_PRIVATE_KEY).address,
    chainId: 900,
    rpcUrl: "http://127.0.0.1:8545",
    commitmentRegistryAddress: ethers.ZeroAddress,
  });
  const holderAddress = "0x000000000000000000000000000000000000dEaD";
  const commitment = 12345678901234567890n;

  const signature = await service.signCommitment(holderAddress, commitment);
  const msgHash = ethers.solidityPackedKeccak256(
    ["address", "uint256"],
    [holderAddress, commitment]
  );
  const recovered = ethers.verifyMessage(ethers.getBytes(msgHash), signature);

  assert.equal(recovered, service.address);
});

test("IssuerService proxies register and existence checks to the contract", async () => {
  const service = new IssuerService({
    privateKey: TEST_PRIVATE_KEY,
    did: "did:ethr:900:test",
    address: new ethers.Wallet(TEST_PRIVATE_KEY).address,
    chainId: 900,
    rpcUrl: "http://127.0.0.1:8545",
    commitmentRegistryAddress: ethers.ZeroAddress,
  });

  let registeredCommitment: bigint | undefined;
  let registeredSignature: string | undefined;

  (service as any).commitmentRegistry = {
    registerCommitment: async (commitment: bigint, signature: string) => {
      registeredCommitment = commitment;
      registeredSignature = signature;
      return {
        wait: async () => ({ hash: "0xtesthash" }),
      };
    },
    commitmentExists: async (commitment: bigint) => commitment === 77n,
  };

  const txHash = await service.registerCommitmentOnChain(77n, "0xsig");

  assert.equal(txHash, "0xtesthash");
  assert.equal(registeredCommitment, 77n);
  assert.equal(registeredSignature, "0xsig");
  assert.equal(await service.isCommitmentRegistered(77n), true);
  assert.equal(await service.isCommitmentRegistered(78n), false);
});
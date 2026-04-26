/**
 * Integration tests for the full age verification system:
 *   IssuerRegistry -> CommitmentRegistry -> AgeVerifier (mock) -> AgeRegistry
 */

const { ethers } = require("hardhat");
const { expect } = require("chai");
const { buildPoseidon } = require("circomlibjs");

describe("AgeRegistry System", function () {
  let issuerRegistry;
  let commitmentRegistry;
  let ageRegistry;

  let owner;
  let issuer;
  let user;
  let other;

  let poseidonHash;
  let commitment;
  let nullifier;

  const birthTimestamp = BigInt(631152000);
  const secret = BigInt("0xdeadbeefcafe1234567890abcdef");

  before(async () => {
    [owner, issuer, user, other] = await ethers.getSigners();

    const poseidon = await buildPoseidon();
    const F = poseidon.F;
    poseidonHash = (inputs) => BigInt(F.toString(poseidon(inputs)));

    commitment = poseidonHash([birthTimestamp, secret]);
    nullifier = poseidonHash([secret, birthTimestamp]);
  });

  beforeEach(async () => {
    const IssuerRegistryFactory = await ethers.getContractFactory("IssuerRegistry");
    issuerRegistry = await IssuerRegistryFactory.deploy();

    const CommitmentRegistryFactory = await ethers.getContractFactory("CommitmentRegistry");
    commitmentRegistry = await CommitmentRegistryFactory.deploy(
      await issuerRegistry.getAddress()
    );

    const MockFactory = await ethers.getContractFactory("MockAgeVerifier");
    const mock = await MockFactory.deploy();

    const AgeRegistryFactory = await ethers.getContractFactory("AgeRegistry");
    ageRegistry = await AgeRegistryFactory.deploy(
      await mock.getAddress(),
      await commitmentRegistry.getAddress()
    );
  });

  describe("IssuerRegistry", () => {
    it("allows owner to register an issuer", async () => {
      const did = "did:ethr:31337:0x" + issuer.address.slice(2).toLowerCase();
      await expect(
        issuerRegistry.connect(owner).registerIssuer(did, issuer.address, "Test Issuer")
      )
        .to.emit(issuerRegistry, "IssuerRegistered")
        .withArgs(did, issuer.address, "Test Issuer");

      expect(await issuerRegistry.isValidIssuer(issuer.address)).to.equal(true);
    });

    it("rejects duplicate DID registration", async () => {
      const did = "did:ethr:31337:0x" + issuer.address.slice(2).toLowerCase();
      await issuerRegistry.connect(owner).registerIssuer(did, issuer.address, "Issuer");
      await expect(
        issuerRegistry.connect(owner).registerIssuer(did, other.address, "Issuer 2")
      ).to.be.revertedWith("IssuerRegistry: already registered");
    });

    it("rejects reusing an issuer address for a different DID", async () => {
      const did = "did:ethr:31337:0x" + issuer.address.slice(2).toLowerCase();
      await issuerRegistry.connect(owner).registerIssuer(did, issuer.address, "Issuer");

      await expect(
        issuerRegistry
          .connect(owner)
          .registerIssuer("did:ethr:31337:0x1111111111111111111111111111111111111111", issuer.address, "Issuer 2")
      ).to.be.revertedWith("IssuerRegistry: address already used");
    });

    it("allows owner to revoke an issuer", async () => {
      const did = "did:ethr:31337:0x" + issuer.address.slice(2).toLowerCase();
      await issuerRegistry.connect(owner).registerIssuer(did, issuer.address, "Issuer");
      await issuerRegistry.connect(owner).revokeIssuer(did);
      expect(await issuerRegistry.isValidIssuer(issuer.address)).to.equal(false);
    });

    it("transfers ownership and blocks the previous owner", async () => {
      const did = "did:ethr:31337:0x" + issuer.address.slice(2).toLowerCase();

      await issuerRegistry.connect(owner).transferOwnership(other.address);
      expect(await issuerRegistry.owner()).to.equal(other.address);

      await expect(
        issuerRegistry.connect(owner).registerIssuer(did, issuer.address, "Issuer")
      ).to.be.revertedWith("IssuerRegistry: not owner");

      await expect(
        issuerRegistry.connect(other).registerIssuer(did, issuer.address, "Issuer")
      ).to.emit(issuerRegistry, "IssuerRegistered");
    });

    it("rejects non-owner operations", async () => {
      await expect(
        issuerRegistry.connect(user).registerIssuer("did:x", user.address, "hack")
      ).to.be.revertedWith("IssuerRegistry: not owner");
    });
  });

  describe("CommitmentRegistry", () => {
    beforeEach(async () => {
      const did = "did:ethr:31337:0x" + issuer.address.slice(2).toLowerCase();
      await issuerRegistry.connect(owner).registerIssuer(did, issuer.address, "Test Issuer");
    });

    async function signCommitment(userAddress, value) {
      const msgHash = ethers.solidityPackedKeccak256(
        ["address", "uint256"],
        [userAddress, value]
      );
      return issuer.signMessage(ethers.getBytes(msgHash));
    }

    it("registers a commitment with valid issuer signature", async () => {
      const sig = await signCommitment(user.address, commitment);
      await expect(commitmentRegistry.connect(user).registerCommitment(commitment, sig))
        .to.emit(commitmentRegistry, "CommitmentRegistered")
        .withArgs(user.address, commitment, issuer.address);

      expect(await commitmentRegistry.getCommitment(user.address)).to.equal(commitment);
    });

    it("rejects commitment signed by non-issuer", async () => {
      const sig = await user.signMessage(
        ethers.getBytes(
          ethers.solidityPackedKeccak256(["address", "uint256"], [user.address, commitment])
        )
      );

      await expect(
        commitmentRegistry.connect(user).registerCommitment(commitment, sig)
      ).to.be.revertedWith("CommitmentRegistry: signer is not a valid issuer");
    });

    it("rejects zero commitments", async () => {
      await expect(
        commitmentRegistry.connect(user).registerCommitment(0n, "0x")
      ).to.be.revertedWith("CommitmentRegistry: zero commitment");
    });

    it("rejects malformed issuer signatures", async () => {
      await expect(
        commitmentRegistry.connect(user).registerCommitment(commitment, "0x1234")
      ).to.be.revertedWith("CommitmentRegistry: invalid signature length");
    });

    it("rejects duplicate commitment registration for same user", async () => {
      const sig = await signCommitment(user.address, commitment);
      await commitmentRegistry.connect(user).registerCommitment(commitment, sig);
      const sig2 = await signCommitment(user.address, commitment + 1n);

      await expect(
        commitmentRegistry.connect(user).registerCommitment(commitment + 1n, sig2)
      ).to.be.revertedWith("CommitmentRegistry: user already has commitment");
    });

    it("allows user to revoke their own commitment", async () => {
      const sig = await signCommitment(user.address, commitment);
      await commitmentRegistry.connect(user).registerCommitment(commitment, sig);
      await commitmentRegistry.connect(user).revokeCommitment();
      expect(await commitmentRegistry.getCommitment(user.address)).to.equal(0n);
    });

    it("allows user to register a new commitment after revoking the old one", async () => {
      const sig = await signCommitment(user.address, commitment);
      await commitmentRegistry.connect(user).registerCommitment(commitment, sig);
      await commitmentRegistry.connect(user).revokeCommitment();

      const nextCommitment = commitment + 1n;
      const nextSig = await signCommitment(user.address, nextCommitment);

      await expect(
        commitmentRegistry.connect(user).registerCommitment(nextCommitment, nextSig)
      )
        .to.emit(commitmentRegistry, "CommitmentRegistered")
        .withArgs(user.address, nextCommitment, issuer.address);

      expect(await commitmentRegistry.getCommitment(user.address)).to.equal(nextCommitment);
    });
  });

  describe("AgeRegistry", () => {
    beforeEach(async () => {
      const did = "did:ethr:31337:0x" + issuer.address.slice(2).toLowerCase();
      await issuerRegistry.connect(owner).registerIssuer(did, issuer.address, "Test Issuer");

      const msgHash = ethers.solidityPackedKeccak256(
        ["address", "uint256"],
        [user.address, commitment]
      );
      const sig = await issuer.signMessage(ethers.getBytes(msgHash));
      await commitmentRegistry.connect(user).registerCommitment(commitment, sig);
    });

    it("verifies age successfully with valid proof", async () => {
      const now = Math.floor(Date.now() / 1000);

      await expect(
        ageRegistry
          .connect(user)
          .verifyAge([1n, 2n], [[1n, 2n], [3n, 4n]], [1n, 2n], BigInt(now), nullifier)
      )
        .to.emit(ageRegistry, "AgeVerified")
        .withArgs(user.address, nullifier, (value) => value > BigInt(now));

      expect(await ageRegistry.isVerified(user.address)).to.equal(true);
    });

    it("rejects replay attack (same nullifier used twice)", async () => {
      const now = BigInt(Math.floor(Date.now() / 1000));

      await ageRegistry
        .connect(user)
        .verifyAge([1n, 2n], [[1n, 2n], [3n, 4n]], [1n, 2n], now, nullifier);

      await expect(
        ageRegistry
          .connect(user)
          .verifyAge([1n, 2n], [[1n, 2n], [3n, 4n]], [1n, 2n], now, nullifier)
      ).to.be.revertedWith("AgeRegistry: proof already used");
    });

    it("rejects stale timestamp", async () => {
      const staleTimestamp = BigInt(Math.floor(Date.now() / 1000) - 3600);

      await expect(
        ageRegistry
          .connect(user)
          .verifyAge([1n, 2n], [[1n, 2n], [3n, 4n]], [1n, 2n], staleTimestamp, nullifier)
      ).to.be.revertedWith("AgeRegistry: timestamp too old");
    });

    it("rejects timestamps too far in the future", async () => {
      const latestBlock = await ethers.provider.getBlock("latest");
      const futureTimestamp = BigInt((latestBlock?.timestamp ?? 0) + 3600);

      await expect(
        ageRegistry
          .connect(user)
          .verifyAge([1n, 2n], [[1n, 2n], [3n, 4n]], [1n, 2n], futureTimestamp, nullifier)
      ).to.be.revertedWith("AgeRegistry: timestamp in future");
    });

    it("rejects user without registered commitment", async () => {
      const now = BigInt(Math.floor(Date.now() / 1000));

      await expect(
        ageRegistry
          .connect(other)
          .verifyAge([1n, 2n], [[1n, 2n], [3n, 4n]], [1n, 2n], now, nullifier)
      ).to.be.revertedWith("AgeRegistry: no active commitment for user");
    });

    it("rejects proofs when the verifier returns false", async () => {
      const RejectingFactory = await ethers.getContractFactory("RejectingAgeVerifier");
      const rejectingVerifier = await RejectingFactory.deploy();

      const AgeRegistryFactory = await ethers.getContractFactory("AgeRegistry");
      const rejectingAgeRegistry = await AgeRegistryFactory.deploy(
        await rejectingVerifier.getAddress(),
        await commitmentRegistry.getAddress()
      );

      const now = BigInt(Math.floor(Date.now() / 1000));
      await expect(
        rejectingAgeRegistry
          .connect(user)
          .verifyAge([1n, 2n], [[1n, 2n], [3n, 4n]], [1n, 2n], now, nullifier)
      ).to.be.revertedWith("AgeRegistry: invalid ZK proof");
    });

    it("expires verifications after the validity window", async () => {
      const now = Math.floor(Date.now() / 1000);

      await ageRegistry
        .connect(user)
        .verifyAge([1n, 2n], [[1n, 2n], [3n, 4n]], [1n, 2n], BigInt(now), nullifier);

      const expiresAt = await ageRegistry.getVerificationExpiry(user.address);
      expect(await ageRegistry.isVerified(user.address)).to.equal(true);

      await ethers.provider.send("evm_setNextBlockTimestamp", [Number(expiresAt) + 1]);
      await ethers.provider.send("evm_mine", []);

      expect(await ageRegistry.isVerified(user.address)).to.equal(false);
    });
  });
});
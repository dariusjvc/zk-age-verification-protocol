//! prover/src/prover.rs
//! Groth16 proof generation and verification using ark-circom + ark-groth16.
//!
//! The prover loads the circuit artifacts (WASM + zkey) once at startup,
//! then handles proof requests concurrently via an Arc<ProverState>.

use std::path::PathBuf;
use std::sync::Arc;

use ark_bn254::{Bn254, Fq, Fq2, Fr};
use ark_circom::{CircomBuilder, CircomConfig};
use ark_groth16::{Groth16, ProvingKey, VerifyingKey, prepare_verifying_key};
use ark_snark::SNARK;
use ark_std::rand::thread_rng;
use num_bigint::BigUint;
use thiserror::Error;
use tokio::sync::Mutex;
use tracing::info;

#[derive(Debug, Error)]
pub enum ProverError {
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),
    #[error("Circuit error: {0}")]
    Circuit(String),
    #[error("Proof error: {0}")]
    Proof(String),
    #[error("Field error: {0}")]
    Field(String),
}

// ─── Prover state ──────────────────────────────────────────────────────

/// Thread-safe prover state loaded once at startup.
pub struct ProverState {
    wasm_path: PathBuf,
    r1cs_path: PathBuf,
    /// Proving key (large — cached after first load)
    proving_key: Arc<ProvingKey<Bn254>>,
    /// Verifying key (derived from proving key, cheap to store)
    verifying_key: Arc<VerifyingKey<Bn254>>,
    /// Mutex to serialize proof generation (Groth16 RNG is single-threaded)
    _lock: Arc<Mutex<()>>,
}

impl ProverState {
    /// Load circuit files and proving key from disk.
    pub async fn load(
        wasm_path: PathBuf,
        r1cs_path: PathBuf,
        zkey_path: PathBuf,
    ) -> Result<Self, ProverError> {
        info!("Loading circuit config...");

        // Build a template circuit to extract the proving key
        let cfg = CircomConfig::<Fr>::new(&wasm_path, &r1cs_path)
            .map_err(|e| ProverError::Circuit(e.to_string()))?;

        // Build with dummy inputs to get the constraint matrices
        let mut builder = CircomBuilder::new(cfg);
        // Push dummy inputs for key generation (values don't matter)
        builder.push_input("birthTimestamp", BigUint::from(0u64));
        builder.push_input("secret",         BigUint::from(1u64));
        builder.push_input("currentTimestamp", BigUint::from(567648001u64));
        builder.push_input("commitment",     BigUint::from(0u64));
        builder.push_input("nullifier",      BigUint::from(0u64));

        info!("Loading proving key from zkey file: {}", zkey_path.display());

        // Load the proving key from the zkey file
        // ark-circom can read snarkjs-generated zkey files
        let (proving_key, verifying_key) = load_zkey(&zkey_path)?;

        info!("Proving key loaded ({} bytes)", std::mem::size_of::<ProvingKey<Bn254>>());

        Ok(Self {
            wasm_path,
            r1cs_path,
            proving_key:   Arc::new(proving_key),
            verifying_key: Arc::new(verifying_key),
            _lock: Arc::new(Mutex::new(())),
        })
    }

    /// Generate a Groth16 proof for the given inputs.
    ///
    /// The commitment and nullifier are computed by the WASM witness generator,
    /// given the private inputs (birthTimestamp, secret) and current timestamp.
    /// The caller must provide pre-computed commitment and nullifier values.
    pub async fn prove(
        &self,
        birth_timestamp: u64,
        secret: BigUint,
        current_timestamp: u64,
    ) -> Result<ProofOutput, ProverError> {
        let wasm_path = self.wasm_path.clone();
        let r1cs_path = self.r1cs_path.clone();
        let proving_key = self.proving_key.clone();

        // Compute commitment = Poseidon(birthTimestamp, secret)
        // Compute nullifier  = Poseidon(secret, birthTimestamp)
        // These are computed inside the WASM witness generator — the circuit
        // enforces that the public commitment matches the private pre-image.
        // We need to compute them here to populate the public inputs.

        // For the witness, we provide all inputs; the WASM computes intermediate signals.
        // Since we cannot run browser-JS Poseidon in Rust directly, we first compute
        // the witness with all inputs null for commitment/nullifier (the circuit constraints
        // will enforce them). However, ark-circom's witness builder calls the WASM which
        // computes them internally.
        //
        // The trick: pass 0 for commitment/nullifier on first pass → the WASM computes
        // the correct values from birthTimestamp + secret → we read them back.

        let proof_result = tokio::task::spawn_blocking(move || {
            let cfg = CircomConfig::<Fr>::new(&wasm_path, &r1cs_path)
                .map_err(|e| ProverError::Circuit(e.to_string()))?;

            let mut builder = CircomBuilder::new(cfg);
            builder.push_input("birthTimestamp",   birth_timestamp);
            builder.push_input("secret",           secret.clone());
            builder.push_input("currentTimestamp", current_timestamp);

            // Build circuit to get computed public outputs (commitment, nullifier)
            let circom = builder.setup();
            let public_inputs: Vec<Fr> = circom
                .get_public_inputs()
                .ok_or_else(|| ProverError::Circuit("Failed to get public inputs".into()))?
                .clone();

            // public_inputs order: [currentTimestamp, commitment, nullifier]
            // (matches the `public` declaration in the circom main component)
            let commitment_fr = public_inputs.get(1)
                .copied()
                .ok_or_else(|| ProverError::Circuit("Missing commitment in public inputs".into()))?;
            let nullifier_fr  = public_inputs.get(2)
                .copied()
                .ok_or_else(|| ProverError::Circuit("Missing nullifier in public inputs".into()))?;

            use ark_ff::{BigInteger, PrimeField};
            let commitment = BigUint::from_bytes_be(&commitment_fr.into_bigint().to_bytes_be());
            let nullifier  = BigUint::from_bytes_be(&nullifier_fr.into_bigint().to_bytes_be());

            // Now rebuild with correct public inputs for proof generation
            let cfg2 = CircomConfig::<Fr>::new(&wasm_path, &r1cs_path)
                .map_err(|e| ProverError::Circuit(e.to_string()))?;
            let mut builder2 = CircomBuilder::new(cfg2);
            builder2.push_input("birthTimestamp",   birth_timestamp);
            builder2.push_input("secret",           secret);
            builder2.push_input("currentTimestamp", current_timestamp);
            builder2.push_input("commitment",       commitment.clone());
            builder2.push_input("nullifier",        nullifier.clone());

            let circom2 = builder2.build()
                .map_err(|e| ProverError::Circuit(e.to_string()))?;

            let mut rng = thread_rng();
            let proof = Groth16::<Bn254>::prove(&proving_key, circom2, &mut rng)
                .map_err(|e| ProverError::Proof(e.to_string()))?;

            Ok::<_, ProverError>((proof, commitment, nullifier))
        })
        .await
        .map_err(|e| ProverError::Proof(format!("Spawn error: {e}")))?;

        let (proof, commitment, nullifier) = proof_result?;

        use ark_ff::{BigInteger, PrimeField};
        let encode = |pt: ark_bn254::G1Affine| {
            let x = BigUint::from_bytes_be(&pt.x.into_bigint().to_bytes_be());
            let y = BigUint::from_bytes_be(&pt.y.into_bigint().to_bytes_be());
            [format!("{x:#066x}"), format!("{y:#066x}")]
        };
        let encode_g2 = |pt: ark_bn254::G2Affine| {
            let x0 = BigUint::from_bytes_be(&pt.x.c0.into_bigint().to_bytes_be());
            let x1 = BigUint::from_bytes_be(&pt.x.c1.into_bigint().to_bytes_be());
            let y0 = BigUint::from_bytes_be(&pt.y.c0.into_bigint().to_bytes_be());
            let y1 = BigUint::from_bytes_be(&pt.y.c1.into_bigint().to_bytes_be());
            [
                [format!("{x0:#066x}"), format!("{x1:#066x}")],
                [format!("{y0:#066x}"), format!("{y1:#066x}")],
            ]
        };

        Ok(ProofOutput {
            proof_a:           encode(proof.a),
            proof_b:           encode_g2(proof.b),
            proof_c:           encode(proof.c),
            current_timestamp: current_timestamp.to_string(),
            commitment:        format!("{commitment}"),
            nullifier:         format!("{nullifier}"),
        })
    }

    /// Verify a proof locally against the verifying key.
    pub async fn verify(&self, inputs: VerifyInputs) -> Result<bool, ProverError> {
        let verifying_key = self.verifying_key.clone();

        // Parse hex/decimal strings back to a scalar field element (Fr)
        let parse_fr = |s: &str| -> Result<Fr, ProverError> {
            let n: BigUint = if s.starts_with("0x") || s.starts_with("0X") {
                BigUint::parse_bytes(s[2..].as_bytes(), 16)
                    .ok_or_else(|| ProverError::Field(format!("Invalid hex: {s}")))?
            } else {
                s.trim().parse::<BigUint>()
                    .map_err(|_| ProverError::Field(format!("Invalid decimal: {s}")))?
            };
            use ark_ff::PrimeField;
            Ok(Fr::from_be_bytes_mod_order(&n.to_bytes_be()))
        };

        // Parse hex/decimal strings back to a base field element (Fq)
        let parse_fq = |s: &str| -> Result<Fq, ProverError> {
            let n: BigUint = if s.starts_with("0x") || s.starts_with("0X") {
                BigUint::parse_bytes(s[2..].as_bytes(), 16)
                    .ok_or_else(|| ProverError::Field(format!("Invalid hex: {s}")))?
            } else {
                s.trim().parse::<BigUint>()
                    .map_err(|_| ProverError::Field(format!("Invalid decimal: {s}")))?
            };
            use ark_ff::PrimeField;
            Ok(Fq::from_be_bytes_mod_order(&n.to_bytes_be()))
        };

        let current_ts = parse_fr(&inputs.current_timestamp)?;
        let commitment = parse_fr(&inputs.commitment)?;
        let nullifier  = parse_fr(&inputs.nullifier)?;
        let public_inputs = vec![current_ts, commitment, nullifier];

        // Parse proof points
        let parse_g1 = |xy: &[String; 2]| -> Result<ark_bn254::G1Affine, ProverError> {
            let x = parse_fq(&xy[0])?;
            let y = parse_fq(&xy[1])?;
            Ok(ark_bn254::G1Affine::new(x, y))
        };
        let parse_g2 = |coords: &[[String; 2]; 2]| -> Result<ark_bn254::G2Affine, ProverError> {
            let x0 = parse_fq(&coords[0][0])?;
            let x1 = parse_fq(&coords[0][1])?;
            let y0 = parse_fq(&coords[1][0])?;
            let y1 = parse_fq(&coords[1][1])?;
            let x = Fq2::new(x0, x1);
            let y = Fq2::new(y0, y1);
            Ok(ark_bn254::G2Affine::new(x, y))
        };

        let a = parse_g1(&inputs.proof_a)?;
        let b = parse_g2(&inputs.proof_b)?;
        let c = parse_g1(&inputs.proof_c)?;

        let proof = ark_groth16::Proof::<Bn254> { a, b, c };
        let pvk   = prepare_verifying_key(&verifying_key);

        tokio::task::spawn_blocking(move || -> Result<bool, ProverError> {
            Groth16::<Bn254>::verify_with_processed_vk(&pvk, &public_inputs, &proof)
                .map_err(|e: ark_relations::r1cs::SynthesisError| ProverError::Proof(e.to_string()))
        })
        .await
        .map_err(|e| ProverError::Proof(format!("Spawn error: {e}")))?
    }
}

// ─── Output types ─────────────────────────────────────────────────────

#[derive(Debug)]
pub struct ProofOutput {
    pub proof_a:           [String; 2],
    pub proof_b:           [[String; 2]; 2],
    pub proof_c:           [String; 2],
    pub current_timestamp: String,
    pub commitment:        String,
    pub nullifier:         String,
}

#[derive(Debug)]
pub struct VerifyInputs {
    pub proof_a:           [String; 2],
    pub proof_b:           [[String; 2]; 2],
    pub proof_c:           [String; 2],
    pub current_timestamp: String,
    pub commitment:        String,
    pub nullifier:         String,
}

// ─── zkey loading ─────────────────────────────────────────────────────

/// Loads a Groth16 proving key + verifying key from a snarkjs-compatible zkey file.
/// ark-circom provides `read_zkey` for this purpose.
fn load_zkey(path: &PathBuf) -> Result<(ProvingKey<Bn254>, VerifyingKey<Bn254>), ProverError> {
    use std::fs::File;
    use std::io::BufReader;

    let file = File::open(path)
        .map_err(|e| ProverError::Io(e))?;
    let mut reader = BufReader::new(file);

    let (proving_key, _matrices) = ark_circom::read_zkey(&mut reader)
        .map_err(|e| ProverError::Circuit(format!("Failed to read zkey: {e}")))?;

    let verifying_key = proving_key.vk.clone();
    Ok((proving_key, verifying_key))
}

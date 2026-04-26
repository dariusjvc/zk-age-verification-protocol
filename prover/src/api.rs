//! prover/src/api.rs
//! Axum HTTP handler definitions.

use std::sync::Arc;
use axum::{
    extract::State,
    http::StatusCode,
    response::IntoResponse,
    Json,
};
use serde::{Deserialize, Serialize};
use num_bigint::BigUint;
use tracing::{error, info};

use crate::AppState;
use crate::prover::ProofOutput;

// ─── Request / Response types ─────────────────────────────────────────

/// POST /prove — Private inputs to the age_check circuit.
#[derive(Debug, Deserialize)]
pub struct ProveRequest {
    /// Unix timestamp of birth date (private — never logged)
    pub birth_timestamp: u64,
    /// Random secret (private — never logged)
    pub secret: String, // decimal string for BigUint
    /// Current Unix timestamp (public)
    pub current_timestamp: u64,
}

/// Proof response — all values are hex strings to avoid JSON bignum issues.
#[derive(Debug, Serialize)]
pub struct ProveResponse {
    pub proof: ProofJson,
    pub public_signals: PublicSignalsJson,
}

#[derive(Debug, Serialize)]
pub struct ProofJson {
    /// G1 point A — [x, y] as hex strings
    pub a: [String; 2],
    /// G2 point B — [[x1, y1], [x2, y2]] as hex strings
    pub b: [[String; 2]; 2],
    /// G1 point C — [x, y] as hex strings
    pub c: [String; 2],
}

#[derive(Debug, Serialize)]
pub struct PublicSignalsJson {
    pub current_timestamp: String,
    pub commitment: String,
    pub nullifier: String,
}

/// POST /verify — Verify a previously generated proof.
#[derive(Debug, Deserialize)]
pub struct VerifyRequest {
    pub proof: ProofInput,
    pub public_signals: PublicSignalsInput,
}

#[derive(Debug, Deserialize)]
pub struct ProofInput {
    pub a: [String; 2],
    pub b: [[String; 2]; 2],
    pub c: [String; 2],
}

#[derive(Debug, Deserialize)]
pub struct PublicSignalsInput {
    pub current_timestamp: String,
    pub commitment: String,
    pub nullifier: String,
}

#[derive(Debug, Serialize)]
pub struct VerifyResponse {
    pub valid: bool,
    pub reason: Option<String>,
}

// ─── Handlers ─────────────────────────────────────────────────────────

/// GET /health
pub async fn health() -> impl IntoResponse {
    Json(serde_json::json!({
        "status":    "ok",
        "service":   "vc-age-prover",
        "version":   env!("CARGO_PKG_VERSION"),
        "timestamp": chrono_now(),
    }))
}

/// POST /prove
/// Generates a Groth16 ZK proof for the age_check circuit.
pub async fn prove(
    State(state): State<Arc<AppState>>,
    Json(req): Json<ProveRequest>,
) -> Result<Json<ProveResponse>, AppError> {
    info!("POST /prove — current_timestamp={}", req.current_timestamp);

    // Parse secret from decimal string
    let secret = req.secret.trim().parse::<BigUint>()
        .map_err(|_| AppError::bad_request("secret must be a decimal integer"))?;

    let output: ProofOutput = state.prover
        .prove(req.birth_timestamp, secret, req.current_timestamp)
        .await
        .map_err(|e| {
            error!("Proof generation error: {e}");
            AppError::internal(format!("Proof generation failed: {e}"))
        })?;

    Ok(Json(ProveResponse {
        proof: ProofJson {
            a: output.proof_a,
            b: output.proof_b,
            c: output.proof_c,
        },
        public_signals: PublicSignalsJson {
            current_timestamp: output.current_timestamp,
            commitment:        output.commitment,
            nullifier:         output.nullifier,
        },
    }))
}

/// POST /verify
/// Verifies a Groth16 proof locally (without on-chain gas costs).
pub async fn verify(
    State(state): State<Arc<AppState>>,
    Json(req): Json<VerifyRequest>,
) -> Result<Json<VerifyResponse>, AppError> {
    info!("POST /verify");

    let inputs = crate::prover::VerifyInputs {
        proof_a: req.proof.a,
        proof_b: req.proof.b,
        proof_c: req.proof.c,
        current_timestamp: req.public_signals.current_timestamp,
        commitment:        req.public_signals.commitment,
        nullifier:         req.public_signals.nullifier,
    };

    match state.prover.verify(inputs).await {
        Ok(true)  => Ok(Json(VerifyResponse { valid: true,  reason: None })),
        Ok(false) => Ok(Json(VerifyResponse { valid: false, reason: Some("Proof rejected by verifier".into()) })),
        Err(e) => {
            error!("Verify error: {e}");
            Ok(Json(VerifyResponse { valid: false, reason: Some(format!("Verification error: {e}")) }))
        }
    }
}

// ─── Error type ───────────────────────────────────────────────────────

pub struct AppError {
    status:  StatusCode,
    message: String,
}

impl AppError {
    pub fn bad_request(msg: impl Into<String>) -> Self {
        Self { status: StatusCode::BAD_REQUEST, message: msg.into() }
    }
    pub fn internal(msg: impl Into<String>) -> Self {
        Self { status: StatusCode::INTERNAL_SERVER_ERROR, message: msg.into() }
    }
}

impl IntoResponse for AppError {
    fn into_response(self) -> axum::response::Response {
        let body = Json(serde_json::json!({ "error": self.message }));
        (self.status, body).into_response()
    }
}

// ─── Helpers ──────────────────────────────────────────────────────────

fn chrono_now() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    format!("{secs}")
}

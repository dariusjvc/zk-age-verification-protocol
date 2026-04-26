//! prover/src/main.rs
//! Entry point for the Rust Groth16 prover service.
//!
//! Starts an Axum HTTP server with routes:
//!   POST /prove   — Generate a Groth16 proof from private inputs
//!   POST /verify  — Verify a Groth16 proof locally
//!   GET  /health  — Health check

mod api;
mod circuit;
mod prover;

use std::{net::SocketAddr, path::PathBuf, sync::Arc};
use axum::{Router, routing::{get, post}};
use tower_http::cors::{Any, CorsLayer};
use tower_http::trace::TraceLayer;
use tracing::info;
use tracing_subscriber::EnvFilter;

use crate::prover::ProverState;

/// Shared application state injected into every Axum handler.
pub struct AppState {
    pub prover: ProverState,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // ── Logging ──────────────────────────────────────────────────────
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()),
        )
        .init();

    // ── Circuit paths ──────────────────────────────────────────────────
    // Default to sibling circuits/build directory.
    let circuits_build = std::env::var("CIRCUITS_BUILD_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| {
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .parent()
                .unwrap()
                .join("circuits")
                .join("build")
        });

    let wasm_path = circuits_build.join("age_check_js").join("age_check.wasm");
    let r1cs_path = circuits_build.join("age_check.r1cs");
    let zkey_path = circuits_build.join("age_check_final.zkey");

    info!("Circuit paths:");
    info!("  WASM : {}", wasm_path.display());
    info!("  R1CS : {}", r1cs_path.display());
    info!("  zkey : {}", zkey_path.display());

    // ── Load circuit and proving key ──────────────────────────────────
    let prover_state = ProverState::load(wasm_path, r1cs_path, zkey_path).await
        .map_err(|e| {
            tracing::error!("Failed to load circuit: {e}");
            tracing::error!("Run `cd circuits && bash scripts/compile.sh && bash scripts/setup.sh` first");
            e
        })?;

    let state = Arc::new(AppState { prover: prover_state });

    // ── CORS ──────────────────────────────────────────────────────────
    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    // ── Router ────────────────────────────────────────────────────────
    let app = Router::new()
        .route("/health", get(api::health))
        .route("/prove",  post(api::prove))
        .route("/verify", post(api::verify))
        .layer(cors)
        .layer(TraceLayer::new_for_http())
        .with_state(state);

    // ── Bind ──────────────────────────────────────────────────────────
    let port: u16 = std::env::var("PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(8080);

    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    info!("Rust prover listening on http://{addr}");
    info!("  POST /prove");
    info!("  POST /verify");
    info!("  GET  /health");

    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, app).await?;

    Ok(())
}

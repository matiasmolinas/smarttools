//! SmartTools navigation core.
//!
//! The deterministic part of SmartTools: from printed-marker corners in a camera image to the
//! 6-DoF pose of the tool. Pure Rust, no dependencies, so the same code runs in the browser
//! (WebAssembly, see [`ffi`]), in a native app and on an embedded camera module.
//!
//! Frames:
//! - **World** = the marker sheet: origin at its centre, X right, Y up, Z out of the surface (metres).
//! - **Camera** (OpenCV convention): x right, y down, z forward. `x_cam = R * X_world + t`.
//!
//! This is a port of the TypeScript prototype (`lib/pose.ts`, `lib/subpix.ts`, `lib/board.ts`).
//! `scripts/engine-parity.mts` checks that both give the same results.

pub mod board;
pub mod ffi;
pub mod geom;
pub mod pose;
pub mod subpix;

pub use geom::{M3, P2, V3};
pub use pose::{Intrinsics, Pose};

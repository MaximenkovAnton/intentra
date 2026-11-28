pub mod adapter;
pub mod adapters;
pub mod config;
pub mod daemon;
pub mod git;
pub mod index;
pub mod job;
pub mod mcp;
pub mod protocol;
pub mod register;
pub mod state;
pub mod token;
pub mod transport;
pub mod update;
pub mod util;
pub mod verify;

pub const PROTOCOL_VERSION: u32 = protocol::PROTOCOL_VERSION;

pub const EXIT_OK: i32 = 0;
pub const EXIT_FAILURE: i32 = 1;
pub const EXIT_USAGE: i32 = 2;
pub const EXIT_CONFIG: i32 = 3;
pub const EXIT_AUTH: i32 = 4;
pub const EXIT_NOT_RUNNING: i32 = 5;

pub fn version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn protocol_version_is_exposed() {
        assert_eq!(PROTOCOL_VERSION, 1);
        assert_eq!(version(), env!("CARGO_PKG_VERSION"));
    }
}

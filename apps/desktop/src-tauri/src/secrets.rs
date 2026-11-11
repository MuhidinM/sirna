//! Secrets live in Windows Credential Manager, never in SQLite, logs or the
//! webview (plan §9). The UI can set a secret and ask whether one exists, but
//! nothing returns a secret's value to the webview.

use keyring_core::{Entry, Error};

const SERVICE: &str = "dev.sirna.app";

/// Makes Windows Credential Manager the store. Call once at start-up.
pub fn init() -> Result<(), Error> {
    keyring_core::set_default_store(windows_native_keyring_store::Store::new()?);
    Ok(())
}

pub fn set(name: &str, value: &str) -> Result<(), Error> {
    Entry::new(SERVICE, name)?.set_password(value)
}

/// Rust-side read, for network calls only.
#[allow(dead_code)] // used from M4 (Gemini key)
pub fn get(name: &str) -> Result<String, Error> {
    Entry::new(SERVICE, name)?.get_password()
}

pub fn exists(name: &str) -> Result<bool, Error> {
    match Entry::new(SERVICE, name)?.get_password() {
        Ok(_) => Ok(true),
        Err(Error::NoEntry) => Ok(false),
        Err(error) => Err(error),
    }
}

pub fn delete(name: &str) -> Result<(), Error> {
    match Entry::new(SERVICE, name)?.delete_credential() {
        Ok(()) | Err(Error::NoEntry) => Ok(()),
        Err(error) => Err(error),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Touches the real Credential Manager, so it is opt-in:
    /// `cargo test -- --ignored secrets`.
    #[test]
    #[ignore = "writes to Windows Credential Manager"]
    fn round_trips_through_credential_manager() {
        init().expect("init store");
        let name = "test-round-trip";
        delete(name).expect("clean start");
        assert!(!exists(name).expect("exists before"));
        set(name, "value-1").expect("set");
        assert!(exists(name).expect("exists after"));
        assert_eq!(get(name).expect("get"), "value-1");
        delete(name).expect("delete");
        assert!(!exists(name).expect("exists after delete"));
    }
}

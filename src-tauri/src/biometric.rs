use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use zeroize::Zeroizing;

use crate::security::{
    constant_time_eq, ensure_migration_recovered, key_verifier, load_security_config,
    require_unlocked_key, save_security_config, security_status, set_unlocked_key, SecurityStatus,
    KEY_LEN, PBKDF2_ITERATIONS,
};
use crate::{atomic_write, fsync_parent, lock_storage_ops, security_journal_path};

// ─── Security limitation ───────────────────────────────────────────────────────
// The biometric unlock flow uses a two-step approach:
//   1. The AES key is stored in an OS credential store (macOS Keychain /
//      Windows Credential Manager).
//   2. A separate biometric prompt (LAContext on macOS, UserConsentVerifier on
//      Windows) gates the UI before the key is read.
//
// However, the stored key is NOT cryptographically bound to the biometric.
// On macOS, the Keychain item uses kSecAttrAccessibleWhenUnlockedThisDeviceOnly
// but does NOT use SecAccessControl with .biometryCurrentSet, so any process
// running as the same user can read it without passing Touch ID.
// On Windows, the key is a plain GenericCredential (CRED_PERSIST_ENTERPRISE);
// UserConsentVerifier is a UI-only gate, not a TPM/NGC-bound operation.
//
// Mitigation paths (future work):
//   macOS: Create the Keychain item with SecAccessControlCreateWithFlags(
//          ..., .biometryCurrentSet | .privateKeyUsage, ...) and pass
//          kSecUseAuthenticationContext so the key never leaves the Secure Enclave
//          without a live biometric check.
//   Windows: Wrap the key using KeyCredentialManager (NGC/TPM-backed) or
//          DPAPI-NG with a Windows Hello credential, instead of a plain
//          GenericCredential.
//
// Until then, the biometric gate provides defence-in-depth (requires physical
// presence at the machine) but should not be considered equivalent to hardware-
// bound key protection.
// ────────────────────────────────────────────────────────────────────────────────

pub fn is_available() -> bool {
    platform::is_available()
}

/// Remove the biometric key and prove it is no longer present.
///
/// Credential-store deletion APIs can fail silently (for example, because the
/// Keychain is unavailable). Destructive security operations must not report
/// success until a non-prompting presence check confirms the key is gone.
pub fn clear_stored_key_verified() -> Result<(), String> {
    platform::remove_key();
    if platform::has_stored_key()? {
        Err(
            "The stored biometric key could not be removed from the system credential store. \
             Remove it manually before using this device again."
                .to_string(),
        )
    } else {
        Ok(())
    }
}

/// What a pending cleanup journal means for the stored credential.
///
/// The distinction matters because the committed configuration is only
/// sometimes evidence about the credential. When a transition can still roll
/// back to an enrolled state, `biometric_enrolled = true` proves the key is
/// still wanted. When the caller has already destroyed vault state, no config
/// bit can justify keeping the key.
#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
enum BiometricCleanupMode {
    /// Remove the credential unless the committed config still claims enrollment.
    ClearUnlessEnrolled,
    /// Remove the credential regardless of what the config claims.
    ClearUnconditionally,
}

#[derive(serde::Serialize, serde::Deserialize)]
struct BiometricCleanupJournal {
    v: u8,
    mode: BiometricCleanupMode,
}

fn biometric_cleanup_journal_path<R: tauri::Runtime, M: tauri::Manager<R>>(
    app: &M,
) -> Result<std::path::PathBuf, String> {
    let security_journal = security_journal_path(app)?;
    let parent = security_journal
        .parent()
        .ok_or_else(|| "Security journal has no parent directory".to_string())?;
    Ok(parent.join("biometric-cleanup.journal"))
}

fn write_biometric_cleanup_journal<R: tauri::Runtime, M: tauri::Manager<R>>(
    app: &M,
    mode: BiometricCleanupMode,
) -> Result<(), String> {
    let journal = serde_json::to_string_pretty(&BiometricCleanupJournal { v: 1, mode })
        .map_err(|err| err.to_string())?;
    atomic_write(&biometric_cleanup_journal_path(app)?, &journal)
}

fn remove_biometric_cleanup_journal<R: tauri::Runtime, M: tauri::Manager<R>>(
    app: &M,
) -> Result<(), String> {
    let path = biometric_cleanup_journal_path(app)?;
    match std::fs::remove_file(&path) {
        Ok(()) => fsync_parent(&path),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(format!(
            "Failed to remove biometric cleanup journal '{}': {}",
            path.display(),
            err
        )),
    }
}

/// Complete credential cleanup recorded before a biometric state transition.
/// The journal is removed last, making both enrollment rollback and disablement
/// recoverable across crashes and credential-store failures.
pub(crate) fn recover_pending_biometric_cleanup<R: tauri::Runtime, M: tauri::Manager<R>>(
    app: &M,
) -> Result<(), String> {
    let path = biometric_cleanup_journal_path(app)?;
    if !path.exists() {
        return Ok(());
    }
    let raw = std::fs::read_to_string(&path).map_err(|err| {
        format!(
            "Biometric cleanup journal '{}' is unreadable and was retained: {}",
            path.display(),
            err
        )
    })?;
    let journal: BiometricCleanupJournal = serde_json::from_str(&raw).map_err(|err| {
        format!(
            "Biometric cleanup journal '{}' is invalid and was retained: {}",
            path.display(),
            err
        )
    })?;
    if journal.v != 1 {
        return Err(format!(
            "Unsupported biometric cleanup journal version {}; journal retained",
            journal.v
        ));
    }

    let mut config = load_security_config(app)?;
    match journal.mode {
        BiometricCleanupMode::ClearUnlessEnrolled if config.biometric_enrolled => {
            // The committed configuration still claims enrollment, so the
            // transition rolled back and the key is still the one that config
            // describes. Retaining it keeps config and credential consistent.
        }
        BiometricCleanupMode::ClearUnlessEnrolled => {
            clear_stored_key_verified()?;
        }
        BiometricCleanupMode::ClearUnconditionally => {
            if config.biometric_enrolled {
                config.biometric_enrolled = false;
                save_security_config(app, &config)?;
            }
            clear_stored_key_verified()?;
        }
    }

    remove_biometric_cleanup_journal(app)
}

/// Record that a transition is moving to `biometric_enrolled = false` but may
/// still roll back. Use only where a surviving `biometric_enrolled = true`
/// genuinely means the old credential is still the correct one.
pub(crate) fn journal_cleanup_unless_enrolled<R: tauri::Runtime, M: tauri::Manager<R>>(
    app: &M,
) -> Result<(), String> {
    write_biometric_cleanup_journal(app, BiometricCleanupMode::ClearUnlessEnrolled)
}

/// Record that the credential must go no matter what the configuration says.
///
/// Callers that have already discarded vault data or key material cannot treat
/// a surviving `biometric_enrolled = true` as evidence, because that bit may
/// simply be the stale configuration they failed to overwrite.
pub(crate) fn journal_unconditional_cleanup<R: tauri::Runtime, M: tauri::Manager<R>>(
    app: &M,
) -> Result<(), String> {
    write_biometric_cleanup_journal(app, BiometricCleanupMode::ClearUnconditionally)
}

fn disable_biometric_durably<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Result<(), String> {
    journal_unconditional_cleanup(app)?;
    crate::security::recover_interrupted_migration(app)
}

#[tauri::command]
pub(crate) fn biometric_available() -> bool {
    is_available()
}

#[tauri::command]
pub(crate) async fn enable_biometric(app: tauri::AppHandle) -> Result<SecurityStatus, String> {
    let _guard = lock_storage_ops()?;
    ensure_migration_recovered()?;
    let mut config = load_security_config(&app)?;
    if !config.encryption_enabled {
        return Err("Encryption is not enabled".to_string());
    }
    if config.biometric_enrolled {
        return Ok(security_status(&config));
    }
    if !is_available() {
        return Err("Biometric authentication is not available on this device".to_string());
    }

    // Record rollback intent before placing the key in the credential store. If
    // the process dies before the config commit, startup removes the key; if the
    // committed config says enrolled, recovery knows the enrollment succeeded.
    let key = require_unlocked_key()?;
    write_biometric_cleanup_journal(&app, BiometricCleanupMode::ClearUnlessEnrolled)?;
    if let Err(store_error) = platform::store_key(&key) {
        let cleanup = crate::security::recover_interrupted_migration(&app);
        return match cleanup {
            Ok(()) => Err(store_error),
            Err(cleanup_error) => Err(format!(
                "{}. Biometric rollback also failed: {}",
                store_error, cleanup_error
            )),
        };
    }

    config.biometric_enrolled = true;
    let save_result = save_security_config(&app, &config);
    let cleanup_result = crate::security::recover_interrupted_migration(&app);
    if let Err(save_error) = save_result {
        return match cleanup_result {
            Ok(()) => Err(save_error),
            Err(cleanup_error) => Err(format!(
                "{}. Biometric enrollment recovery also failed: {}",
                save_error, cleanup_error
            )),
        };
    }
    cleanup_result?;
    Ok(security_status(&config))
}

#[tauri::command]
pub(crate) async fn disable_biometric(app: tauri::AppHandle) -> Result<SecurityStatus, String> {
    let _guard = lock_storage_ops()?;
    ensure_migration_recovered()?;
    // Persist intent first. Recovery commits `biometric_enrolled = false`,
    // removes the key, verifies absence, and only then clears the journal.
    disable_biometric_durably(&app)?;
    let config = load_security_config(&app)?;
    Ok(security_status(&config))
}

#[tauri::command]
pub(crate) async fn unlock_biometric(
    app: tauri::AppHandle,
    window: tauri::Window,
) -> Result<SecurityStatus, String> {
    let _guard = lock_storage_ops()?;
    let config = load_security_config(&app)?;
    if !config.encryption_enabled || !config.biometric_enrolled {
        return Err("Biometric unlock is not configured".to_string());
    }
    if config.pbkdf2_iterations < PBKDF2_ITERATIONS {
        return Err(
            "A one-time password unlock is required to upgrade encrypted storage after updating S3 Sidekick."
                .to_string(),
        );
    }

    let key = Zeroizing::new(match platform::retrieve_key(Some(&window)) {
        Ok(k) => k,
        Err(err) => {
            let is_not_found = err.contains("0x80070490")
                || err.contains("Element not found")
                || err.contains("OSStatus -34018");
            if is_not_found {
                disable_biometric_durably(&app)?;
                return Err(
                    "Biometric credential was removed from the system. Please unlock with your password and re-enable biometric unlock."
                        .to_string(),
                );
            }
            return Err(
                "Biometric authentication failed. Please try again or unlock with your password."
                    .to_string(),
            );
        }
    });

    let expected = B64
        .decode(&config.verifier)
        .map_err(|e| format!("Invalid verifier: {}", e))?;
    if expected.len() != KEY_LEN {
        disable_biometric_durably(&app)?;
        return Err("Invalid security configuration".to_string());
    }

    let computed = key_verifier(&key);
    if !constant_time_eq(&computed, &expected) {
        disable_biometric_durably(&app)?;
        return Err(
            "Stored biometric key is no longer valid. Please unlock with your password and re-enable biometric unlock."
                .to_string(),
        );
    }

    let timeout = config.lock_timeout_minutes as u64 * 60;
    set_unlocked_key(Some(*key), timeout)?;
    if let Err(err) = crate::security::recover_interrupted_migration(&app) {
        let _ = set_unlocked_key(None, 0);
        return Err(err);
    }
    let mut config = config;
    if let Err(err) = crate::security::adopt_legacy_plaintext_files(&app, &mut config) {
        let _ = set_unlocked_key(None, 0);
        return Err(err);
    }
    Ok(security_status(&config))
}

// ---------------------------------------------------------------------------
// macOS: Keychain with biometric access control + LAContext availability check
// ---------------------------------------------------------------------------
#[cfg(target_os = "macos")]
mod platform {
    use super::KEY_LEN;
    use core_foundation::base::{kCFAllocatorDefault, CFRelease, TCFType};
    use core_foundation::data::CFData;
    use core_foundation::string::CFString;
    use security_framework_sys::base::errSecSuccess;
    use std::ffi::c_void;
    use std::ptr;

    #[link(name = "LocalAuthentication", kind = "framework")]
    extern "C" {}

    extern "C" {
        static kSecClass: *const c_void;
        static kSecClassGenericPassword: *const c_void;
        static kSecAttrService: *const c_void;
        static kSecAttrAccount: *const c_void;
        static kSecValueData: *const c_void;
        static kSecReturnData: *const c_void;
        static kSecMatchLimit: *const c_void;
        static kSecMatchLimitOne: *const c_void;
        static kSecAttrAccessible: *const c_void;
        static kSecAttrAccessibleWhenUnlockedThisDeviceOnly: *const c_void;
        static kCFBooleanTrue: *const c_void;

        fn SecItemAdd(attributes: *const c_void, result: *mut *const c_void) -> i32;
        fn SecItemCopyMatching(query: *const c_void, result: *mut *const c_void) -> i32;
        fn SecItemDelete(query: *const c_void) -> i32;

        fn CFDictionaryCreateMutable(
            allocator: *const c_void,
            capacity: isize,
            key_callbacks: *const c_void,
            value_callbacks: *const c_void,
        ) -> *mut c_void;

        fn CFDictionarySetValue(dict: *mut c_void, key: *const c_void, value: *const c_void);

        static kCFTypeDictionaryKeyCallBacks: c_void;
        static kCFTypeDictionaryValueCallBacks: c_void;
    }

    const SERVICE: &str = "run.rosie.s3-sidekick";
    const ACCOUNT: &str = "biometric-encryption-key";

    // -----------------------------------------------------------------------
    // Touch ID via LAContext (avoids keychain-access-groups entitlement)
    // -----------------------------------------------------------------------
    //
    // Two correctness hazards had to be handled here.
    //
    // 1. Block lifetime. The reply block used to be a stack local tagged as a
    //    *global* block. `Block_copy` is a no-op for global blocks, so
    //    LocalAuthentication retained a pointer straight into the caller's stack
    //    frame. When the 120-second wait timed out, that frame was destroyed
    //    while the framework still held the pointer; a late callback would then
    //    read `block->invoke` out of reclaimed stack memory. Blocks are now heap
    //    allocated and never freed while the framework might still hold them.
    //
    // 2. Reply attribution. The callback wrote its result into a single global
    //    slot with no notion of which request it belonged to, so a reply from a
    //    prompt that had already timed out could satisfy a *later* unlock
    //    attempt — a stale `true` would open the vault. Every request now carries
    //    its own generation number inside the block, and a waiter only accepts a
    //    result stamped with its own generation.

    use std::sync::atomic::{AtomicU64, Ordering};

    #[derive(Default)]
    struct AuthSlot {
        /// Generation the current waiter is expecting, if any.
        awaiting: Option<u64>,
        /// The most recent reply, tagged with the generation it belongs to.
        result: Option<(u64, bool)>,
    }

    struct AuthState {
        slot: std::sync::Mutex<AuthSlot>,
        condvar: std::sync::Condvar,
    }

    static AUTH_STATE: std::sync::OnceLock<AuthState> = std::sync::OnceLock::new();
    static AUTH_GENERATION: AtomicU64 = AtomicU64::new(1);
    /// Serialises authentication attempts so two prompts never overlap.
    static AUTH_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    const BLOCK_IS_GLOBAL: i32 = 1 << 28;
    const LA_POLICY_DEVICE_OWNER_AUTHENTICATION: isize = 1;
    const AUTH_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(120);

    fn auth_state() -> &'static AuthState {
        AUTH_STATE.get_or_init(|| AuthState {
            slot: std::sync::Mutex::new(AuthSlot::default()),
            condvar: std::sync::Condvar::new(),
        })
    }

    /// Raw Objective-C block layout for the LAContext reply handler.
    ///
    /// `generation` is a captured variable: it identifies which request this
    /// block belongs to so the callback can be attributed correctly.
    #[repr(C)]
    struct LAReplyBlock {
        isa: *const c_void,
        flags: i32,
        reserved: i32,
        invoke: unsafe extern "C" fn(*mut LAReplyBlock, i8, *const c_void),
        descriptor: *const LAReplyBlockDesc,
        generation: u64,
    }

    #[repr(C)]
    struct LAReplyBlockDesc {
        reserved: usize,
        size: usize,
    }

    extern "C" {
        static _NSConcreteGlobalBlock: c_void;
    }

    static LA_REPLY_DESC: LAReplyBlockDesc = LAReplyBlockDesc {
        reserved: 0,
        size: std::mem::size_of::<LAReplyBlock>(),
    };

    fn lock_slot(m: &std::sync::Mutex<AuthSlot>) -> std::sync::MutexGuard<'_, AuthSlot> {
        m.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Allocate one process-lifetime reply block tagged with `generation`.
    ///
    /// LocalAuthentication may retain its reference after invoking the callback,
    /// so callback completion is not proof that the allocation can be reused or
    /// mutated. Each prompt therefore receives a stable leaked block. Prompt
    /// creation is rare, and preserving framework-owned pointer validity is more
    /// important than reclaiming these few bytes.
    ///
    /// # Safety
    /// The returned pointer stays valid and immutable for the remainder of the process.
    unsafe fn allocate_reply_block(generation: u64) -> *mut LAReplyBlock {
        Box::into_raw(Box::new(LAReplyBlock {
            isa: &_NSConcreteGlobalBlock as *const c_void,
            flags: BLOCK_IS_GLOBAL,
            reserved: 0,
            invoke: la_reply_invoke,
            descriptor: &LA_REPLY_DESC,
            generation,
        }))
    }

    unsafe extern "C" fn la_reply_invoke(
        block: *mut LAReplyBlock,
        success: i8,
        _error: *const c_void,
    ) {
        let generation = if block.is_null() {
            0
        } else {
            (*block).generation
        };

        let state = auth_state();
        {
            let mut slot = lock_slot(&state.slot);
            // Only record a reply the current waiter is actually expecting.
            // Anything else belongs to an abandoned prompt and must be dropped.
            if slot.awaiting == Some(generation) {
                slot.result = Some((generation, success != 0));
                state.condvar.notify_all();
            }
        }
    }

    fn authenticate_touch_id() -> Result<(), String> {
        // One prompt at a time.
        let _serial = AUTH_LOCK.lock().unwrap_or_else(|e| e.into_inner());

        let state = auth_state();
        let generation = AUTH_GENERATION.fetch_add(1, Ordering::Relaxed);

        unsafe {
            let cls = objc2::runtime::AnyClass::get(c"LAContext")
                .ok_or_else(|| "Touch ID not available".to_string())?;
            let ctx: objc2::rc::Retained<objc2::runtime::AnyObject> = objc2::msg_send![cls, new];

            let reason = CFString::new("Unlock S3 Sidekick encrypted storage");
            let block = allocate_reply_block(generation);

            {
                let mut slot = lock_slot(&state.slot);
                slot.awaiting = Some(generation);
                slot.result = None;
            }

            let _: () = objc2::msg_send![
                &*ctx,
                evaluatePolicy: LA_POLICY_DEVICE_OWNER_AUTHENTICATION,
                localizedReason: reason.as_concrete_TypeRef() as *const c_void,
                reply: block as *const c_void
            ];

            let mut slot = lock_slot(&state.slot);
            let outcome = loop {
                if let Some((gen, success)) = slot.result.take() {
                    if gen == generation {
                        break Some(success);
                    }
                    // A reply for some other request; ignore and keep waiting.
                    continue;
                }
                let (next, wait_result) = state
                    .condvar
                    .wait_timeout(slot, AUTH_TIMEOUT)
                    .unwrap_or_else(|e| e.into_inner());
                slot = next;
                if wait_result.timed_out() && slot.result.is_none() {
                    break None;
                }
            };

            // Stop expecting a reply. Any callback that arrives from here on finds
            // no matching generation and is discarded.
            slot.awaiting = None;
            drop(slot);

            match outcome {
                Some(true) => Ok(()),
                Some(false) => Err("Touch ID authentication failed or was canceled".to_string()),
                None => {
                    // Tear the prompt down so it cannot linger and fire later.
                    let _: () = objc2::msg_send![&*ctx, invalidate];
                    Err("Touch ID authentication timed out".to_string())
                }
            }
        }
    }

    pub fn is_available() -> bool {
        unsafe {
            let cls = objc2::runtime::AnyClass::get(c"LAContext");
            let Some(cls) = cls else { return false };
            let ctx: objc2::rc::Retained<objc2::runtime::AnyObject> = objc2::msg_send![cls, new];
            let mut err: *mut objc2::runtime::AnyObject = ptr::null_mut();
            let can: objc2::runtime::Bool =
                objc2::msg_send![&*ctx, canEvaluatePolicy: 1_isize, error: &mut err];
            can.as_bool()
        }
    }

    unsafe fn new_dict() -> *mut c_void {
        CFDictionaryCreateMutable(
            kCFAllocatorDefault,
            0,
            &kCFTypeDictionaryKeyCallBacks as *const c_void,
            &kCFTypeDictionaryValueCallBacks as *const c_void,
        )
    }

    unsafe fn set_base_attrs(dict: *mut c_void) {
        let service = CFString::new(SERVICE);
        let account = CFString::new(ACCOUNT);
        CFDictionarySetValue(dict, kSecClass, kSecClassGenericPassword);
        CFDictionarySetValue(dict, kSecAttrService, service.as_concrete_TypeRef() as _);
        CFDictionarySetValue(dict, kSecAttrAccount, account.as_concrete_TypeRef() as _);
    }

    pub fn store_key(key: &[u8; KEY_LEN]) -> Result<(), String> {
        remove_key();

        unsafe {
            let dict = new_dict();
            set_base_attrs(dict);

            let data = CFData::from_buffer(key);
            CFDictionarySetValue(dict, kSecValueData, data.as_concrete_TypeRef() as _);
            CFDictionarySetValue(
                dict,
                kSecAttrAccessible,
                kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
            );

            let status = SecItemAdd(dict, ptr::null_mut());
            CFRelease(dict);

            if status == errSecSuccess {
                Ok(())
            } else {
                Err(format!(
                    "Failed to store biometric key in Keychain (OSStatus {})",
                    status
                ))
            }
        }
    }

    pub fn retrieve_key(_window: Option<&tauri::Window>) -> Result<[u8; KEY_LEN], String> {
        // Authenticate with Touch ID before reading the key from keychain
        authenticate_touch_id()?;

        unsafe {
            let dict = new_dict();
            set_base_attrs(dict);
            CFDictionarySetValue(dict, kSecReturnData, kCFBooleanTrue);
            CFDictionarySetValue(dict, kSecMatchLimit, kSecMatchLimitOne);

            let mut result: *const c_void = ptr::null();
            let status = SecItemCopyMatching(dict, &mut result);

            CFRelease(dict);

            if status != errSecSuccess || result.is_null() {
                if !result.is_null() {
                    CFRelease(result);
                }
                let msg = match status {
                    -128 => "Authentication was canceled".to_string(),
                    -25293 => "Authentication failed".to_string(),
                    _ => format!("Biometric authentication failed (OSStatus {})", status),
                };
                return Err(msg);
            }

            let cf_data = CFData::wrap_under_create_rule(result as _);
            let bytes = cf_data.bytes();
            if bytes.len() != KEY_LEN {
                return Err("Invalid biometric key length".to_string());
            }

            let mut key = [0u8; KEY_LEN];
            key.copy_from_slice(bytes);
            Ok(key)
        }
    }

    pub fn remove_key() {
        unsafe {
            let dict = new_dict();
            set_base_attrs(dict);
            let _ = SecItemDelete(dict);
            CFRelease(dict);
        }
    }

    /// Whether the Keychain still holds our item.
    ///
    /// Deliberately does not request the data, so this never prompts for Touch ID
    /// — it only asks whether the item exists.
    pub fn has_stored_key() -> Result<bool, String> {
        const ERR_SEC_ITEM_NOT_FOUND: i32 = -25300;

        unsafe {
            let dict = new_dict();
            set_base_attrs(dict);
            CFDictionarySetValue(dict, kSecMatchLimit, kSecMatchLimitOne);
            let status = SecItemCopyMatching(dict, ptr::null_mut());
            CFRelease(dict);
            if status == errSecSuccess {
                Ok(true)
            } else if status == ERR_SEC_ITEM_NOT_FOUND {
                Ok(false)
            } else {
                Err(format!(
                    "Failed to verify biometric key removal (OSStatus {})",
                    status
                ))
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Windows: UserConsentVerifier + Win32 Credential Manager
// ---------------------------------------------------------------------------
#[cfg(target_os = "windows")]
mod platform {
    use super::KEY_LEN;
    use std::ptr;
    use std::thread;
    use std::time::Duration;

    use windows::core::{factory, Error, HSTRING, PCWSTR, PWSTR};
    use windows::Foundation::IAsyncOperation;
    use windows::Security::Credentials::UI::{
        UserConsentVerificationResult, UserConsentVerifier, UserConsentVerifierAvailability,
    };
    use windows::Win32::Foundation::{FILETIME, HWND};
    use windows::Win32::Security::Credentials::{
        CredDeleteW, CredFree, CredReadW, CredWriteW, CREDENTIALW, CRED_FLAGS, CRED_PERSIST,
        CRED_PERSIST_ENTERPRISE, CRED_TYPE_GENERIC,
    };
    use windows::Win32::System::WinRT::IUserConsentVerifierInterop;

    const TARGET: &str = "run.rosie.s3-sidekick/biometric-key";
    const WINDOWS_HELLO_RETRY_HRESULT: i32 = 0x80098044u32 as i32;
    const WINDOWS_HELLO_NOT_FOUND_HRESULT: i32 = 0x80070490u32 as i32;
    const WINDOWS_CREDREAD_RETRY_DELAY_MS: u64 = 500;
    const WINDOWS_HELLO_VERIFY_RETRY_DELAY_MS: u64 = 800;
    const WINDOWS_HELLO_VERIFY_MAX_RETRIES: usize = 2;

    fn to_wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    pub fn is_available() -> bool {
        let result = UserConsentVerifier::CheckAvailabilityAsync().and_then(|op| op.get());
        matches!(result, Ok(UserConsentVerifierAvailability::Available))
    }

    fn is_retryable_error(err: &Error) -> bool {
        let code = err.code().0;
        code == WINDOWS_HELLO_RETRY_HRESULT || code == WINDOWS_HELLO_NOT_FOUND_HRESULT
    }

    enum VerifyError {
        WindowsHello(Error),
        Other(String),
    }

    fn verify_user_once(window: Option<&tauri::Window>) -> Result<(), VerifyError> {
        let message = HSTRING::from("Unlock S3 Sidekick encrypted storage");
        let result = if let Some(win) = window {
            let raw_hwnd = win
                .hwnd()
                .map_err(|e| VerifyError::Other(format!("Failed to get window handle: {}", e)))?;
            let hwnd = HWND(raw_hwnd.0 as *mut _);
            let interop: IUserConsentVerifierInterop =
                factory::<UserConsentVerifier, IUserConsentVerifierInterop>().map_err(|e| {
                    VerifyError::Other(format!("Windows Hello interop factory error: {}", e))
                })?;
            unsafe {
                interop
                    .RequestVerificationForWindowAsync::<
                        HWND,
                        IAsyncOperation<UserConsentVerificationResult>,
                    >(hwnd, &message)
                    .map_err(VerifyError::WindowsHello)?
                    .get()
                    .map_err(VerifyError::WindowsHello)?
            }
        } else {
            UserConsentVerifier::RequestVerificationAsync(&message)
                .map_err(VerifyError::WindowsHello)?
                .get()
                .map_err(VerifyError::WindowsHello)?
        };

        match result {
            UserConsentVerificationResult::Verified => Ok(()),
            UserConsentVerificationResult::Canceled => Err(VerifyError::Other(
                "Authentication was canceled".to_string(),
            )),
            _ => Err(VerifyError::Other(
                "Windows Hello authentication failed".to_string(),
            )),
        }
    }

    fn verify_user(window: Option<&tauri::Window>) -> Result<(), String> {
        for attempt in 0..WINDOWS_HELLO_VERIFY_MAX_RETRIES {
            match verify_user_once(window) {
                Ok(()) => return Ok(()),
                Err(VerifyError::WindowsHello(e))
                    if attempt + 1 < WINDOWS_HELLO_VERIFY_MAX_RETRIES =>
                {
                    if is_retryable_error(&e) {
                        thread::sleep(Duration::from_millis(WINDOWS_HELLO_VERIFY_RETRY_DELAY_MS));
                        continue;
                    }
                    return Err(format!("Windows Hello error: {}", e));
                }
                Err(VerifyError::WindowsHello(e)) => {
                    return Err(format!("Windows Hello error: {}", e))
                }
                Err(VerifyError::Other(msg)) => return Err(msg),
            }
        }
        Err("Windows Hello authentication failed after retries".to_string())
    }

    pub fn store_key(key: &[u8; KEY_LEN]) -> Result<(), String> {
        remove_key();
        write_credential(key, CRED_PERSIST_ENTERPRISE)
    }

    fn write_credential(key: &[u8; KEY_LEN], persist: CRED_PERSIST) -> Result<(), String> {
        let mut target_name = to_wide(TARGET);
        let mut user_name = to_wide("s3-sidekick");
        let cred = CREDENTIALW {
            Flags: CRED_FLAGS(0),
            Type: CRED_TYPE_GENERIC,
            TargetName: PWSTR(target_name.as_mut_ptr()),
            Comment: PWSTR::null(),
            LastWritten: FILETIME {
                dwLowDateTime: 0,
                dwHighDateTime: 0,
            },
            CredentialBlobSize: key.len() as u32,
            CredentialBlob: key.as_ptr() as *mut u8,
            Persist: persist,
            AttributeCount: 0,
            Attributes: ptr::null_mut(),
            TargetAlias: PWSTR::null(),
            UserName: PWSTR(user_name.as_mut_ptr()),
        };

        unsafe { CredWriteW(&cred, 0).map_err(|e| format!("Failed to store credential: {}", e)) }
    }

    pub fn retrieve_key(window: Option<&tauri::Window>) -> Result<[u8; KEY_LEN], String> {
        verify_user(window)?;

        let target_wide = to_wide(TARGET);
        let mut pcred: *mut CREDENTIALW = ptr::null_mut();
        let mut read_err: Option<Error> = None;

        for attempt in 0..2 {
            pcred = ptr::null_mut();
            let result = unsafe {
                CredReadW(
                    PCWSTR(target_wide.as_ptr()),
                    CRED_TYPE_GENERIC,
                    0,
                    &mut pcred,
                )
            };
            match result {
                Ok(_) => {
                    read_err = None;
                    break;
                }
                Err(err) if attempt == 0 && is_retryable_error(&err) => {
                    thread::sleep(Duration::from_millis(WINDOWS_CREDREAD_RETRY_DELAY_MS));
                }
                Err(err) => {
                    read_err = Some(err);
                    break;
                }
            }
        }

        if let Some(err) = read_err {
            return Err(format!("Failed to read credential: {}", err));
        }

        unsafe {
            if pcred.is_null() {
                return Err("No biometric credential found".to_string());
            }

            let cred = &*pcred;
            let blob =
                std::slice::from_raw_parts(cred.CredentialBlob, cred.CredentialBlobSize as usize);

            if blob.len() != KEY_LEN {
                CredFree(pcred as *const std::ffi::c_void);
                return Err("Invalid credential length".to_string());
            }

            let mut key = [0u8; KEY_LEN];
            key.copy_from_slice(blob);

            CredFree(pcred as *const std::ffi::c_void);
            Ok(key)
        }
    }

    pub fn remove_key() {
        let target_wide = to_wide(TARGET);
        unsafe {
            let _ = CredDeleteW(PCWSTR(target_wide.as_ptr()), CRED_TYPE_GENERIC, 0);
        }
    }

    /// Whether the credential still exists. Does not prompt the user.
    pub fn has_stored_key() -> Result<bool, String> {
        let target_wide = to_wide(TARGET);
        unsafe {
            let mut pcred: *mut CREDENTIALW = ptr::null_mut();
            match CredReadW(
                PCWSTR(target_wide.as_ptr()),
                CRED_TYPE_GENERIC,
                None,
                &mut pcred,
            ) {
                Ok(()) => {
                    if !pcred.is_null() {
                        CredFree(pcred as *const std::ffi::c_void);
                    }
                    Ok(true)
                }
                Err(err) if err.code().0 == WINDOWS_HELLO_NOT_FOUND_HRESULT => Ok(false),
                Err(err) => Err(format!(
                    "Failed to verify biometric credential removal: {}",
                    err
                )),
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Linux / other: biometric not supported
// ---------------------------------------------------------------------------
#[cfg(not(any(target_os = "macos", target_os = "windows")))]
mod platform {
    use super::KEY_LEN;

    pub fn is_available() -> bool {
        false
    }

    pub fn store_key(_: &[u8; KEY_LEN]) -> Result<(), String> {
        Err("Biometric authentication is not supported on this platform".to_string())
    }

    pub fn retrieve_key(_window: Option<&tauri::Window>) -> Result<[u8; KEY_LEN], String> {
        Err("Biometric authentication is not supported on this platform".to_string())
    }

    pub fn remove_key() {}

    pub fn has_stored_key() -> Result<bool, String> {
        Ok(false)
    }
}

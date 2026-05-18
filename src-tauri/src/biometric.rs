use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use rand::RngCore;
use zeroize::Zeroizing;

use crate::lock_storage_ops;
use crate::security::{
    constant_time_eq, effective_biometric_schema, key_verifier, load_security_config,
    require_unlocked_key, save_security_config, security_status, set_unlocked_key,
    unwrap_vault_key_with_kek, wrap_vault_key_with_kek, BiometricV2, SecurityStatus,
    BIOMETRIC_SCHEMA_NONE, BIOMETRIC_SCHEMA_V1, BIOMETRIC_SCHEMA_V2, KEY_LEN,
};

pub fn is_available() -> bool {
    platform::is_available()
}

pub fn clear_stored_key() {
    platform::remove_key();
    platform::remove_v2_kek();
}

fn platform_tag() -> &'static str {
    if cfg!(target_os = "macos") {
        "macos"
    } else if cfg!(target_os = "windows") {
        "windows"
    } else {
        "unsupported"
    }
}

fn is_not_found_error(err: &str) -> bool {
    err.contains("0x80070490")
        || err.contains("Element not found")
        || err.contains("OSStatus -34018")
        || err.starts_with("NotFound:")
}

#[tauri::command]
pub(crate) fn biometric_available() -> bool {
    is_available()
}

#[tauri::command]
pub(crate) async fn enable_biometric(
    app: tauri::AppHandle,
    window: tauri::Window,
) -> Result<SecurityStatus, String> {
    let _guard = lock_storage_ops()?;
    let mut config = load_security_config(&app)?;
    if !config.encryption_enabled {
        return Err("Encryption is not enabled".to_string());
    }
    if !is_available() {
        return Err("Biometric authentication is not available on this device".to_string());
    }
    let vault_key = Zeroizing::new(require_unlocked_key()?);

    let (kek, opaque) = platform::enroll_v2(Some(&window))?;
    let wrapped = match wrap_vault_key_with_kek(&vault_key, &kek) {
        Ok(w) => w,
        Err(e) => {
            platform::remove_v2_kek();
            return Err(e);
        }
    };

    config.biometric_enrolled = true;
    config.biometric_schema = BIOMETRIC_SCHEMA_V2;
    config.biometric_v2 = Some(BiometricV2 {
        wrapped_vault_key: wrapped,
        opaque: B64.encode(&opaque),
        platform: platform_tag().to_string(),
    });
    if let Err(e) = save_security_config(&app, &config) {
        platform::remove_v2_kek();
        return Err(e);
    }
    platform::remove_key();
    Ok(security_status(&config))
}

#[tauri::command]
pub(crate) async fn disable_biometric(app: tauri::AppHandle) -> Result<SecurityStatus, String> {
    let _guard = lock_storage_ops()?;
    let mut config = load_security_config(&app)?;
    platform::remove_key();
    platform::remove_v2_kek();
    config.biometric_enrolled = false;
    config.biometric_schema = BIOMETRIC_SCHEMA_NONE;
    config.biometric_v2 = None;
    save_security_config(&app, &config)?;
    Ok(security_status(&config))
}

#[tauri::command]
pub(crate) async fn migrate_biometric_to_v2(
    app: tauri::AppHandle,
    window: tauri::Window,
) -> Result<SecurityStatus, String> {
    let _guard = lock_storage_ops()?;
    let mut config = load_security_config(&app)?;
    if !config.encryption_enabled {
        return Err("Encryption is not enabled".to_string());
    }
    if effective_biometric_schema(&config) != BIOMETRIC_SCHEMA_V1 {
        return Err("No legacy biometric enrollment to migrate".to_string());
    }
    if !is_available() {
        return Err("Biometric authentication is not available on this device".to_string());
    }
    let vault_key = Zeroizing::new(require_unlocked_key()?);

    let (kek, opaque) = platform::enroll_v2(Some(&window))?;
    let wrapped = match wrap_vault_key_with_kek(&vault_key, &kek) {
        Ok(w) => w,
        Err(e) => {
            platform::remove_v2_kek();
            return Err(e);
        }
    };

    config.biometric_schema = BIOMETRIC_SCHEMA_V2;
    config.biometric_v2 = Some(BiometricV2 {
        wrapped_vault_key: wrapped,
        opaque: B64.encode(&opaque),
        platform: platform_tag().to_string(),
    });
    if let Err(e) = save_security_config(&app, &config) {
        platform::remove_v2_kek();
        return Err(e);
    }
    platform::remove_key();
    Ok(security_status(&config))
}

#[tauri::command]
pub(crate) async fn unlock_biometric(
    app: tauri::AppHandle,
    window: tauri::Window,
) -> Result<SecurityStatus, String> {
    let _guard = lock_storage_ops()?;
    let mut config = load_security_config(&app)?;
    if !config.encryption_enabled || !config.biometric_enrolled {
        return Err("Biometric unlock is not configured".to_string());
    }

    let schema = effective_biometric_schema(&config);
    let key = match schema {
        BIOMETRIC_SCHEMA_V2 => unlock_v2(&app, &mut config, &window)?,
        _ => unlock_v1(&app, &mut config, &window)?,
    };

    let timeout = config.lock_timeout_minutes as u64 * 60;
    set_unlocked_key(Some(*key), timeout)?;
    Ok(security_status(&config))
}

fn unlock_v1(
    app: &tauri::AppHandle,
    config: &mut crate::security::SecurityConfig,
    window: &tauri::Window,
) -> Result<Zeroizing<[u8; KEY_LEN]>, String> {
    let key = Zeroizing::new(match platform::retrieve_key(Some(window)) {
        Ok(k) => k,
        Err(err) => {
            if is_not_found_error(&err) {
                config.biometric_enrolled = false;
                config.biometric_schema = BIOMETRIC_SCHEMA_NONE;
                config.biometric_v2 = None;
                let _ = save_security_config(app, config);
                platform::remove_key();
                return Err(
                    "Biometric credential was removed from the system. Please unlock with your password and re-enable biometric unlock.".to_string(),
                );
            }
            return Err("Biometric authentication failed. Please try again or unlock with your password.".to_string());
        }
    });

    let expected = B64
        .decode(&config.verifier)
        .map_err(|e| format!("Invalid verifier: {}", e))?;
    if expected.len() != KEY_LEN {
        config.biometric_enrolled = false;
        config.biometric_schema = BIOMETRIC_SCHEMA_NONE;
        config.biometric_v2 = None;
        let _ = save_security_config(app, config);
        return Err("Invalid security configuration".to_string());
    }

    let computed = key_verifier(&key);
    if !constant_time_eq(&computed, &expected) {
        config.biometric_enrolled = false;
        config.biometric_schema = BIOMETRIC_SCHEMA_NONE;
        config.biometric_v2 = None;
        let _ = save_security_config(app, config);
        platform::remove_key();
        return Err(
            "Stored biometric key is no longer valid. Please unlock with your password and re-enable biometric unlock.".to_string(),
        );
    }
    Ok(key)
}

fn unlock_v2(
    app: &tauri::AppHandle,
    config: &mut crate::security::SecurityConfig,
    window: &tauri::Window,
) -> Result<Zeroizing<[u8; KEY_LEN]>, String> {
    let v2 = config
        .biometric_v2
        .clone()
        .ok_or_else(|| "Biometric v2 configuration missing".to_string())?;
    let opaque = B64
        .decode(&v2.opaque)
        .map_err(|e| format!("Invalid biometric opaque: {}", e))?;

    let kek = Zeroizing::new(match platform::retrieve_v2_kek(&opaque, Some(window)) {
        Ok(k) => k,
        Err(err) => {
            if is_not_found_error(&err) {
                config.biometric_enrolled = false;
                config.biometric_schema = BIOMETRIC_SCHEMA_NONE;
                config.biometric_v2 = None;
                let _ = save_security_config(app, config);
                platform::remove_v2_kek();
                return Err(
                    "Biometric credential was removed from the system. Please unlock with your password and re-enable biometric unlock.".to_string(),
                );
            }
            return Err(format!("Biometric authentication failed: {}", err));
        }
    });

    let mut vault_key = match unwrap_vault_key_with_kek(&v2.wrapped_vault_key, &kek) {
        Ok(k) => k,
        Err(_) => {
            config.biometric_enrolled = false;
            config.biometric_schema = BIOMETRIC_SCHEMA_NONE;
            config.biometric_v2 = None;
            let _ = save_security_config(app, config);
            platform::remove_v2_kek();
            return Err(
                "Stored biometric key is no longer valid. Please unlock with your password and re-enable biometric unlock.".to_string(),
            );
        }
    };

    let expected = B64
        .decode(&config.verifier)
        .map_err(|e| format!("Invalid verifier: {}", e))?;
    if expected.len() != KEY_LEN {
        return Err("Invalid security configuration".to_string());
    }
    let computed = key_verifier(&vault_key);
    if !constant_time_eq(&computed, &expected) {
        for b in vault_key.iter_mut() {
            *b = 0;
        }
        config.biometric_enrolled = false;
        config.biometric_schema = BIOMETRIC_SCHEMA_NONE;
        config.biometric_v2 = None;
        let _ = save_security_config(app, config);
        platform::remove_v2_kek();
        return Err(
            "Stored biometric key is no longer valid. Please unlock with your password and re-enable biometric unlock.".to_string(),
        );
    }
    Ok(Zeroizing::new(vault_key))
}

#[allow(dead_code)]
fn random_kek() -> Zeroizing<[u8; KEY_LEN]> {
    let mut kek = Zeroizing::new([0u8; KEY_LEN]);
    rand::rngs::OsRng.fill_bytes(&mut *kek);
    kek
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
        static kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly: *const c_void;
        static kSecAttrAccessControl: *const c_void;
        static kSecUseAuthenticationContext: *const c_void;
        static kCFBooleanTrue: *const c_void;

        fn SecItemAdd(attributes: *const c_void, result: *mut *const c_void) -> i32;
        fn SecItemCopyMatching(query: *const c_void, result: *mut *const c_void) -> i32;
        fn SecItemDelete(query: *const c_void) -> i32;

        fn SecAccessControlCreateWithFlags(
            allocator: *const c_void,
            protection: *const c_void,
            flags: u32,
            error: *mut *const c_void,
        ) -> *const c_void;

        fn CFDictionaryCreateMutable(
            allocator: *const c_void,
            capacity: isize,
            key_callbacks: *const c_void,
            value_callbacks: *const c_void,
        ) -> *mut c_void;

        fn CFDictionarySetValue(
            dict: *mut c_void,
            key: *const c_void,
            value: *const c_void,
        );

        static kCFTypeDictionaryKeyCallBacks: c_void;
        static kCFTypeDictionaryValueCallBacks: c_void;
    }

    const ERR_SEC_ITEM_NOT_FOUND: i32 = -25300;
    const SEC_ACCESS_CONTROL_BIOMETRY_CURRENT_SET: u32 = 1 << 3;

    const SERVICE: &str = "run.rosie.s3-sidekick";
    const ACCOUNT: &str = "biometric-encryption-key";
    const ACCOUNT_V2: &str = "biometric-kek-v2";
    const V2_PROMPT: &str = "Unlock S3 Sidekick encrypted storage";

    // -----------------------------------------------------------------------
    // Touch ID via LAContext (avoids keychain-access-groups entitlement)
    // -----------------------------------------------------------------------
    struct AuthState {
        result: std::sync::Mutex<Option<bool>>,
        condvar: std::sync::Condvar,
    }

    static AUTH_STATE: std::sync::OnceLock<AuthState> = std::sync::OnceLock::new();

    fn auth_state() -> &'static AuthState {
        AUTH_STATE.get_or_init(|| AuthState {
            result: std::sync::Mutex::new(None),
            condvar: std::sync::Condvar::new(),
        })
    }

    /// Raw Objective-C block layout for the LAContext reply handler.
    /// No captured variables — result is communicated via the global AUTH_STATE.
    #[repr(C)]
    struct LAReplyBlock {
        isa: *const c_void,
        flags: i32,
        reserved: i32,
        invoke: unsafe extern "C" fn(*mut LAReplyBlock, i8, *const c_void),
        descriptor: *const LAReplyBlockDesc,
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

    /// Recover the Mutex guard whether the Mutex is poisoned or not.
    fn lock_auth_result(
        m: &std::sync::Mutex<Option<bool>>,
    ) -> std::sync::MutexGuard<'_, Option<bool>> {
        m.lock().unwrap_or_else(|e| e.into_inner())
    }

    unsafe extern "C" fn la_reply_invoke(
        _block: *mut LAReplyBlock,
        success: i8,
        _error: *const c_void,
    ) {
        let state = auth_state();
        *lock_auth_result(&state.result) = Some(success != 0);
        state.condvar.notify_one();
    }

    fn authenticate_touch_id() -> Result<(), String> {
        let state = auth_state();
        *lock_auth_result(&state.result) = None;

        unsafe {
            let cls = objc2::runtime::AnyClass::get(c"LAContext")
                .ok_or_else(|| "Touch ID not available".to_string())?;
            let ctx: objc2::rc::Retained<objc2::runtime::AnyObject> =
                objc2::msg_send![cls, new];

            let reason = CFString::new("Unlock S3 Sidekick encrypted storage");

            let block = LAReplyBlock {
                isa: &_NSConcreteGlobalBlock as *const c_void,
                flags: (1 << 28),  // BLOCK_IS_GLOBAL
                reserved: 0,
                invoke: la_reply_invoke,
                descriptor: &LA_REPLY_DESC,
            };

            let _: () = objc2::msg_send![
                &*ctx,
                evaluatePolicy: 1_isize,
                localizedReason: reason.as_concrete_TypeRef() as *const c_void,
                reply: &block as *const LAReplyBlock as *const c_void
            ];

            // Block stays alive on the stack while we wait for the async callback.
            // Use a timeout to prevent indefinite blocking if the callback never fires.
            let timeout = std::time::Duration::from_secs(120);
            let mut guard = lock_auth_result(&state.result);
            while guard.is_none() {
                let (new_guard, wait_result) = state
                    .condvar
                    .wait_timeout(guard, timeout)
                    .unwrap_or_else(|e| e.into_inner());
                guard = new_guard;
                if wait_result.timed_out() && guard.is_none() {
                    return Err("Touch ID authentication timed out".to_string());
                }
            }

            if guard.unwrap() {
                Ok(())
            } else {
                Err("Touch ID authentication failed or was canceled".to_string())
            }
        }
    }

    pub fn is_available() -> bool {
        unsafe {
            let cls = objc2::runtime::AnyClass::get(c"LAContext");
            let Some(cls) = cls else { return false };
            let ctx: objc2::rc::Retained<objc2::runtime::AnyObject> =
                objc2::msg_send![cls, new];
            let mut err: *mut objc2::runtime::AnyObject = ptr::null_mut();
            let can: objc2::runtime::Bool =
                objc2::msg_send![&*ctx, canEvaluatePolicy: 1_isize, error: &mut err];
            can.as_bool()
        }
    }

    unsafe fn new_dict() -> *mut c_void {
        CFDictionaryCreateMutable(
            kCFAllocatorDefault as *const c_void,
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

    unsafe fn set_base_attrs_v2(dict: *mut c_void) {
        let service = CFString::new(SERVICE);
        let account = CFString::new(ACCOUNT_V2);
        CFDictionarySetValue(dict, kSecClass, kSecClassGenericPassword);
        CFDictionarySetValue(dict, kSecAttrService, service.as_concrete_TypeRef() as _);
        CFDictionarySetValue(dict, kSecAttrAccount, account.as_concrete_TypeRef() as _);
    }

    #[allow(dead_code)]
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
                    ERR_SEC_ITEM_NOT_FOUND => {
                        "NotFound: keychain item missing".to_string()
                    }
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

    pub fn enroll_v2(_window: Option<&tauri::Window>) -> Result<(super::Zeroizing<[u8; KEY_LEN]>, Vec<u8>), String> {
        let kek = super::random_kek();
        remove_v2_kek();

        unsafe {
            let mut err: *const c_void = std::ptr::null();
            let access = SecAccessControlCreateWithFlags(
                kCFAllocatorDefault as *const c_void,
                kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly,
                SEC_ACCESS_CONTROL_BIOMETRY_CURRENT_SET,
                &mut err,
            );
            if access.is_null() {
                if !err.is_null() {
                    CFRelease(err);
                }
                return Err(
                    "Failed to create biometric access control. Touch ID may not be enrolled."
                        .to_string(),
                );
            }

            let dict = new_dict();
            set_base_attrs_v2(dict);
            let data = CFData::from_buffer(&*kek);
            CFDictionarySetValue(dict, kSecValueData, data.as_concrete_TypeRef() as _);
            CFDictionarySetValue(dict, kSecAttrAccessControl, access);

            let status = SecItemAdd(dict, std::ptr::null_mut());
            CFRelease(dict);
            CFRelease(access);

            if status != errSecSuccess {
                return Err(format!(
                    "Failed to store biometric KEK in Keychain (OSStatus {})",
                    status
                ));
            }
        }

        Ok((kek, Vec::new()))
    }

    pub fn retrieve_v2_kek(
        _opaque: &[u8],
        _window: Option<&tauri::Window>,
    ) -> Result<[u8; KEY_LEN], String> {
        unsafe {
            let la_cls = objc2::runtime::AnyClass::get(c"LAContext")
                .ok_or_else(|| "LAContext unavailable".to_string())?;
            let la_ctx: objc2::rc::Retained<objc2::runtime::AnyObject> =
                objc2::msg_send![la_cls, new];
            let reason = CFString::new(V2_PROMPT);
            let _: () = objc2::msg_send![
                &*la_ctx,
                setLocalizedReason: reason.as_concrete_TypeRef() as *const c_void
            ];

            let dict = new_dict();
            set_base_attrs_v2(dict);
            CFDictionarySetValue(dict, kSecReturnData, kCFBooleanTrue);
            CFDictionarySetValue(dict, kSecMatchLimit, kSecMatchLimitOne);
            CFDictionarySetValue(
                dict,
                kSecUseAuthenticationContext,
                objc2::rc::Retained::as_ptr(&la_ctx) as *const c_void,
            );

            let mut result: *const c_void = ptr::null();
            let status = SecItemCopyMatching(dict, &mut result);
            CFRelease(dict);
            drop(la_ctx);

            if status != errSecSuccess || result.is_null() {
                if !result.is_null() {
                    CFRelease(result);
                }
                let msg = match status {
                    -128 => "Authentication was canceled".to_string(),
                    -25293 => "Authentication failed".to_string(),
                    ERR_SEC_ITEM_NOT_FOUND => {
                        "NotFound: keychain item missing".to_string()
                    }
                    _ => format!("Biometric authentication failed (OSStatus {})", status),
                };
                return Err(msg);
            }

            let cf_data = CFData::wrap_under_create_rule(result as _);
            let bytes = cf_data.bytes();
            if bytes.len() != KEY_LEN {
                return Err("Invalid biometric KEK length".to_string());
            }
            let mut kek = [0u8; KEY_LEN];
            kek.copy_from_slice(bytes);
            Ok(kek)
        }
    }

    pub fn remove_v2_kek() {
        unsafe {
            let dict = new_dict();
            set_base_attrs_v2(dict);
            let _ = SecItemDelete(dict);
            CFRelease(dict);
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

    use hkdf::Hkdf;
    use rand::RngCore;
    use sha2::Sha256;
    use tauri::Manager;
    use windows::core::{factory, Error, HSTRING, PCWSTR, PWSTR};
    use windows::Foundation::IAsyncOperation;
    use windows::Security::Credentials::{
        KeyCredentialCreationOption, KeyCredentialManager, KeyCredentialStatus,
    };
    use windows::Security::Credentials::UI::{
        UserConsentVerificationResult, UserConsentVerifier, UserConsentVerifierAvailability,
    };
    use windows::Security::Cryptography::CryptographicBuffer;
    use windows::Win32::Foundation::{FILETIME, HWND};
    use windows::Win32::Security::Credentials::{
        CredDeleteW, CredFree, CredReadW, CredWriteW, CREDENTIALW, CRED_FLAGS, CRED_PERSIST,
        CRED_PERSIST_ENTERPRISE, CRED_TYPE_GENERIC,
    };
    use windows::Win32::System::WinRT::IUserConsentVerifierInterop;

    const TARGET: &str = "run.rosie.s3-sidekick/biometric-key";
    const V2_CRED_NAME: &str = "run.rosie.s3-sidekick.v2";
    const V2_HKDF_INFO: &[u8] = b"s3sk-biometric-kek-v1";
    const V2_CHALLENGE_LEN: usize = 32;
    const WINDOWS_HELLO_RETRY_HRESULT: i32 = 0x80098044u32 as i32;
    const WINDOWS_HELLO_NOT_FOUND_HRESULT: i32 = 0x80070490u32 as i32;
    const WINDOWS_CREDREAD_RETRY_DELAY_MS: u64 = 500;
    const WINDOWS_HELLO_VERIFY_RETRY_DELAY_MS: u64 = 800;
    const WINDOWS_HELLO_VERIFY_MAX_RETRIES: usize = 2;

    fn to_wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    pub fn is_available() -> bool {
        let result = UserConsentVerifier::CheckAvailabilityAsync()
            .and_then(|op| op.get());
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
                factory::<UserConsentVerifier, IUserConsentVerifierInterop>()
                    .map_err(|e| VerifyError::Other(format!("Windows Hello interop factory error: {}", e)))?;
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
            UserConsentVerificationResult::Canceled => {
                Err(VerifyError::Other("Authentication was canceled".to_string()))
            }
            _ => Err(VerifyError::Other("Windows Hello authentication failed".to_string())),
        }
    }

    fn verify_user(window: Option<&tauri::Window>) -> Result<(), String> {
        for attempt in 0..WINDOWS_HELLO_VERIFY_MAX_RETRIES {
            match verify_user_once(window) {
                Ok(()) => return Ok(()),
                Err(VerifyError::WindowsHello(e)) if attempt + 1 < WINDOWS_HELLO_VERIFY_MAX_RETRIES => {
                    if is_retryable_error(&e) {
                        thread::sleep(Duration::from_millis(WINDOWS_HELLO_VERIFY_RETRY_DELAY_MS));
                        continue;
                    }
                    return Err(format!("Windows Hello error: {}", e));
                }
                Err(VerifyError::WindowsHello(e)) => return Err(format!("Windows Hello error: {}", e)),
                Err(VerifyError::Other(msg)) => return Err(msg),
            }
        }
        Err("Windows Hello authentication failed after retries".to_string())
    }

    #[allow(dead_code)]
    pub fn store_key(key: &[u8; KEY_LEN]) -> Result<(), String> {
        remove_key();
        write_credential(key, CRED_PERSIST_ENTERPRISE)
    }

    #[allow(dead_code)]
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

        unsafe {
            CredWriteW(&cred, 0).map_err(|e| format!("Failed to store credential: {}", e))
        }
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
            let blob = std::slice::from_raw_parts(
                cred.CredentialBlob,
                cred.CredentialBlobSize as usize,
            );

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

    fn derive_kek(signature: &[u8]) -> [u8; KEY_LEN] {
        let hk = Hkdf::<Sha256>::new(None, signature);
        let mut okm = [0u8; KEY_LEN];
        hk.expand(V2_HKDF_INFO, &mut okm)
            .expect("HKDF expand for KEK_LEN bytes must succeed");
        okm
    }

    fn ibuffer_to_vec(buf: &windows::Storage::Streams::IBuffer) -> Result<Vec<u8>, String> {
        let mut out = windows::core::Array::<u8>::new();
        CryptographicBuffer::CopyToByteArray(buf, &mut out)
            .map_err(|e| format!("Failed to read buffer: {}", e))?;
        Ok(out.as_slice().to_vec())
    }

    fn run_on_main_thread_blocking<F, R>(
        window: Option<&tauri::Window>,
        f: F,
    ) -> Result<R, String>
    where
        F: FnOnce() -> R + Send + 'static,
        R: Send + 'static,
    {
        let win = window
            .ok_or_else(|| "Window handle required for Windows Hello operation".to_string())?;
        let app = win.app_handle().clone();
        let (tx, rx) = std::sync::mpsc::channel();
        app.run_on_main_thread(move || {
            let _ = tx.send(f());
        })
        .map_err(|e| format!("Failed to schedule on main thread: {}", e))?;
        rx.recv()
            .map_err(|e| format!("Main thread channel closed: {}", e))
    }

    pub fn enroll_v2(
        window: Option<&tauri::Window>,
    ) -> Result<(super::Zeroizing<[u8; KEY_LEN]>, Vec<u8>), String> {
        let supported = KeyCredentialManager::IsSupportedAsync()
            .and_then(|op| op.get())
            .unwrap_or(false);
        if !supported {
            return Err(
                "Windows Hello key credentials are not supported on this device (TPM required for hardware-bound biometric unlock)."
                    .to_string(),
            );
        }

        let mut challenge = vec![0u8; V2_CHALLENGE_LEN];
        rand::rngs::OsRng.fill_bytes(&mut challenge);

        let challenge_for_main = challenge.clone();
        let signature: Vec<u8> = run_on_main_thread_blocking(window, move || -> Result<Vec<u8>, String> {
            let name = HSTRING::from(V2_CRED_NAME);
            let create_op = KeyCredentialManager::RequestCreateAsync(
                &name,
                KeyCredentialCreationOption::ReplaceExisting,
            )
            .map_err(|e| format!("KeyCredentialManager create failed: {}", e))?;
            let create_result = create_op
                .get()
                .map_err(|e| format!("KeyCredentialManager create await failed: {}", e))?;
            let status = create_result
                .Status()
                .map_err(|e| format!("KeyCredential status read failed: {}", e))?;
            if status != KeyCredentialStatus::Success {
                return Err(format!(
                    "KeyCredential creation rejected by Windows Hello (status {:?})",
                    status
                ));
            }
            let credential = create_result
                .Credential()
                .map_err(|e| format!("KeyCredential read failed: {}", e))?;

            let challenge_buf = CryptographicBuffer::CreateFromByteArray(&challenge_for_main)
                .map_err(|e| format!("Challenge buffer create failed: {}", e))?;
            let sign_op = credential
                .RequestSignAsync(&challenge_buf)
                .map_err(|e| format!("RequestSignAsync failed: {}", e))?;
            let sign_result = sign_op
                .get()
                .map_err(|e| format!("Sign await failed: {}", e))?;
            let sign_status = sign_result
                .Status()
                .map_err(|e| format!("Sign status read failed: {}", e))?;
            if sign_status != KeyCredentialStatus::Success {
                return Err(format!(
                    "KeyCredential sign rejected (status {:?})",
                    sign_status
                ));
            }
            let sig_buf = sign_result
                .Result()
                .map_err(|e| format!("Sign result read failed: {}", e))?;
            ibuffer_to_vec(&sig_buf)
        })?
        .map_err(|e| {
            remove_v2_kek();
            e
        })?;

        let kek_bytes = derive_kek(&signature);
        let mut kek = super::Zeroizing::new([0u8; KEY_LEN]);
        kek.copy_from_slice(&kek_bytes);
        Ok((kek, challenge))
    }

    pub fn retrieve_v2_kek(
        opaque: &[u8],
        window: Option<&tauri::Window>,
    ) -> Result<[u8; KEY_LEN], String> {
        if opaque.len() != V2_CHALLENGE_LEN {
            return Err("Invalid biometric challenge length".to_string());
        }

        let opaque_owned = opaque.to_vec();
        let signature: Vec<u8> = run_on_main_thread_blocking(window, move || -> Result<Vec<u8>, String> {
            let name = HSTRING::from(V2_CRED_NAME);
            let open_op = KeyCredentialManager::OpenAsync(&name)
                .map_err(|e| format!("KeyCredentialManager open failed: {}", e))?;
            let open_result = open_op
                .get()
                .map_err(|e| format!("KeyCredentialManager open await failed: {}", e))?;
            let open_status = open_result
                .Status()
                .map_err(|e| format!("KeyCredential open status read failed: {}", e))?;
            if open_status != KeyCredentialStatus::Success {
                if open_status == KeyCredentialStatus::NotFound {
                    return Err("NotFound: biometric credential missing".to_string());
                }
                return Err(format!(
                    "KeyCredential open rejected (status {:?})",
                    open_status
                ));
            }
            let credential = open_result
                .Credential()
                .map_err(|e| format!("KeyCredential read failed: {}", e))?;

            let challenge_buf = CryptographicBuffer::CreateFromByteArray(&opaque_owned)
                .map_err(|e| format!("Challenge buffer create failed: {}", e))?;
            let sign_op = credential
                .RequestSignAsync(&challenge_buf)
                .map_err(|e| format!("RequestSignAsync failed: {}", e))?;
            let sign_result = sign_op
                .get()
                .map_err(|e| format!("Sign await failed: {}", e))?;
            let sign_status = sign_result
                .Status()
                .map_err(|e| format!("Sign status read failed: {}", e))?;
            if sign_status != KeyCredentialStatus::Success {
                if sign_status == KeyCredentialStatus::UserCanceled {
                    return Err("Authentication was canceled".to_string());
                }
                if sign_status == KeyCredentialStatus::NotFound {
                    return Err("NotFound: biometric credential vanished during sign".to_string());
                }
                return Err(format!(
                    "KeyCredential sign rejected (status {:?})",
                    sign_status
                ));
            }
            let sig_buf = sign_result
                .Result()
                .map_err(|e| format!("Sign result read failed: {}", e))?;
            ibuffer_to_vec(&sig_buf)
        })??;

        Ok(derive_kek(&signature))
    }

    pub fn remove_v2_kek() {
        let name = HSTRING::from(V2_CRED_NAME);
        if let Ok(op) = KeyCredentialManager::DeleteAsync(&name) {
            let _ = op.get();
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

    #[allow(dead_code)]
    pub fn store_key(_: &[u8; KEY_LEN]) -> Result<(), String> {
        Err("Biometric authentication is not supported on this platform".to_string())
    }

    pub fn retrieve_key(_window: Option<&tauri::Window>) -> Result<[u8; KEY_LEN], String> {
        Err("Biometric authentication is not supported on this platform".to_string())
    }

    pub fn remove_key() {}

    pub fn enroll_v2(
        _window: Option<&tauri::Window>,
    ) -> Result<(super::Zeroizing<[u8; KEY_LEN]>, Vec<u8>), String> {
        Err("Biometric authentication is not supported on this platform".to_string())
    }

    pub fn retrieve_v2_kek(
        _opaque: &[u8],
        _window: Option<&tauri::Window>,
    ) -> Result<[u8; KEY_LEN], String> {
        Err("Biometric authentication is not supported on this platform".to_string())
    }

    pub fn remove_v2_kek() {}
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clear_stored_key_does_not_panic() {
        clear_stored_key();
    }
}

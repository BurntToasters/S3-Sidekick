use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use zeroize::Zeroizing;

use crate::lock_storage_ops;
use crate::security::{
    constant_time_eq, key_verifier, load_security_config, require_unlocked_key,
    save_security_config, security_status, set_unlocked_key, SecurityStatus, KEY_LEN,
};

pub fn is_available() -> bool {
    platform::is_available()
}

pub fn clear_stored_key() {
    platform::remove_key();
}

#[tauri::command]
pub(crate) fn biometric_available() -> bool {
    is_available()
}

#[tauri::command]
pub(crate) async fn enable_biometric(app: tauri::AppHandle) -> Result<SecurityStatus, String> {
    let _guard = lock_storage_ops()?;
    let mut config = load_security_config(&app)?;
    if !config.encryption_enabled {
        return Err("Encryption is not enabled".to_string());
    }
    if !is_available() {
        return Err("Biometric authentication is not available on this device".to_string());
    }
    let key = Zeroizing::new(require_unlocked_key()?);
    let result = platform::store_key(&key);
    result?;
    config.biometric_enrolled = true;
    save_security_config(&app, &config)?;
    Ok(security_status(&config))
}

#[tauri::command]
pub(crate) async fn disable_biometric(app: tauri::AppHandle) -> Result<SecurityStatus, String> {
    let _guard = lock_storage_ops()?;
    let mut config = load_security_config(&app)?;
    platform::remove_key();
    config.biometric_enrolled = false;
    save_security_config(&app, &config)?;
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

    let key = Zeroizing::new(match platform::retrieve_key(Some(&window)) {
        Ok(k) => k,
        Err(err) => {
            let is_not_found = err.contains("0x80070490")
                || err.contains("Element not found")
                || err.contains("OSStatus -34018");
            if is_not_found {
                config.biometric_enrolled = false;
                let _ = save_security_config(&app, &config);
                platform::remove_key();
                return Err(
                    "Biometric credential was removed from the system. Please unlock with your password and re-enable biometric unlock."
                        .to_string(),
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
        let _ = save_security_config(&app, &config);
        return Err("Invalid security configuration".to_string());
    }

    let computed = key_verifier(&key);
    if !constant_time_eq(&computed, &expected) {
        config.biometric_enrolled = false;
        let _ = save_security_config(&app, &config);
        platform::remove_key();
        return Err(
            "Stored biometric key is no longer valid. Please unlock with your password and re-enable biometric unlock."
                .to_string(),
        );
    }

    let timeout = config.lock_timeout_minutes as u64 * 60;
    set_unlocked_key(Some(*key), timeout)?;
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

        fn CFDictionarySetValue(
            dict: *mut c_void,
            key: *const c_void,
            value: *const c_void,
        );

        static kCFTypeDictionaryKeyCallBacks: c_void;
        static kCFTypeDictionaryValueCallBacks: c_void;
    }

    const ERR_SEC_ITEM_NOT_FOUND: i32 = -25300;

    const SERVICE: &str = "run.rosie.s3-sidekick";
    const ACCOUNT: &str = "biometric-encryption-key";

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
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clear_stored_key_does_not_panic() {
        clear_stored_key();
    }
}

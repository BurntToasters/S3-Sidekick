use base64::{engine::general_purpose::STANDARD as B64, Engine as _};

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

// Removed is_cancellation_error
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
    let key = require_unlocked_key()?;
    platform::store_key(&key)?;
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
pub(crate) async fn unlock_biometric(app: tauri::AppHandle) -> Result<SecurityStatus, String> {
    let _guard = lock_storage_ops()?;
    let mut config = load_security_config(&app)?;
    if !config.encryption_enabled || !config.biometric_enrolled {
        return Err("Biometric unlock is not configured".to_string());
    }

    let key = match platform::retrieve_key() {
        Ok(k) => k,
        Err(e) => return Err(e),
    };

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
    set_unlocked_key(Some(key), timeout)?;
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
        static kSecAttrAccessControl: *const c_void;
        static kSecAttrAccessibleWhenUnlockedThisDeviceOnly: *const c_void;
        static kSecUseOperationPrompt: *const c_void;
        static kCFBooleanTrue: *const c_void;

        fn SecAccessControlCreateWithFlags(
            allocator: *const c_void,
            protection: *const c_void,
            flags: u64,
            error: *mut *mut c_void,
        ) -> *mut c_void;

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

    const BIOMETRY_CURRENT_SET: u64 = 1 << 3;
    const ERR_SEC_ITEM_NOT_FOUND: i32 = -25300;

    const SERVICE: &str = "run.rosie.s3-sidekick";
    const ACCOUNT: &str = "biometric-encryption-key";

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
            let mut error: *mut c_void = ptr::null_mut();
            let access_control = SecAccessControlCreateWithFlags(
                kCFAllocatorDefault as *const c_void,
                kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
                BIOMETRY_CURRENT_SET,
                &mut error,
            );
            if access_control.is_null() {
                if !error.is_null() {
                    CFRelease(error);
                }
                return Err(
                    "Failed to create biometric access control. Touch ID may not be configured."
                        .to_string(),
                );
            }

            let dict = new_dict();
            set_base_attrs(dict);

            let data = CFData::from_buffer(key);
            CFDictionarySetValue(dict, kSecValueData, data.as_concrete_TypeRef() as _);
            CFDictionarySetValue(dict, kSecAttrAccessControl, access_control);

            let status = SecItemAdd(dict, ptr::null_mut());

            CFRelease(dict);
            CFRelease(access_control);

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

    pub fn retrieve_key() -> Result<[u8; KEY_LEN], String> {
        unsafe {
            let dict = new_dict();
            set_base_attrs(dict);
            CFDictionarySetValue(dict, kSecReturnData, kCFBooleanTrue);
            CFDictionarySetValue(dict, kSecMatchLimit, kSecMatchLimitOne);

            let prompt = CFString::new("Unlock S3 Sidekick encrypted storage");
            CFDictionarySetValue(dict, kSecUseOperationPrompt, prompt.as_concrete_TypeRef() as _);

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

    use windows::core::{HSTRING, PCWSTR, PWSTR};
    use windows::Security::Credentials::UI::{
        UserConsentVerificationResult, UserConsentVerifier, UserConsentVerifierAvailability,
    };
    use windows::Win32::Foundation::FILETIME;
    use windows::Win32::Security::Credentials::{
        CredDeleteW, CredFree, CredReadW, CredWriteW, CREDENTIALW, CRED_FLAGS, CRED_PERSIST,
        CRED_PERSIST_ENTERPRISE, CRED_PERSIST_LOCAL_MACHINE, CRED_TYPE_GENERIC,
    };

    const TARGET: &str = "run.rosie.s3-sidekick/biometric-key";

    fn to_wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    pub fn is_available() -> bool {
        let result = UserConsentVerifier::CheckAvailabilityAsync()
            .and_then(|op| op.get());
        matches!(result, Ok(UserConsentVerifierAvailability::Available))
    }

    fn verify_user() -> Result<(), String> {
        let message = HSTRING::from("Unlock S3 Sidekick encrypted storage");
        let result = UserConsentVerifier::RequestVerificationAsync(&message)
            .map_err(|e| format!("Windows Hello error: {}", e))?
            .get()
            .map_err(|e| format!("Windows Hello error: {}", e))?;

        match result {
            UserConsentVerificationResult::Verified => Ok(()),
            UserConsentVerificationResult::Canceled => {
                Err("Authentication was canceled".to_string())
            }
            _ => Err("Windows Hello authentication failed".to_string()),
        }
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

    pub fn retrieve_key() -> Result<[u8; KEY_LEN], String> {
        verify_user()?;

        let target_wide = to_wide(TARGET);
        let mut pcred: *mut CREDENTIALW = ptr::null_mut();

        unsafe {
            CredReadW(
                PCWSTR(target_wide.as_ptr()),
                CRED_TYPE_GENERIC,
                0,
                &mut pcred,
            )
            .map_err(|e| format!("Failed to read credential: {}", e))?;

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

    pub fn retrieve_key() -> Result<[u8; KEY_LEN], String> {
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

use windows::core::{PCWSTR, HSTRING};
use windows::Security::Credentials::UI::UserConsentVerifier;
use windows::Win32::Security::Credentials::{
    CredReadW, CREDENTIALW, CRED_TYPE_GENERIC,
};
use std::ptr;

fn to_wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

fn main() {
    let message = HSTRING::from("Test Prompt");
    println!("Requesting verification...");
    let result = UserConsentVerifier::RequestVerificationAsync(&message).unwrap().get().unwrap();
    println!("Verification result: {:?}", result);

    let target_name = to_wide("run.rosie.s3-sidekick/test-biometric-key");
    let mut pcred: *mut CREDENTIALW = ptr::null_mut();
    let res3 = unsafe { CredReadW(PCWSTR(target_name.as_ptr()), CRED_TYPE_GENERIC, 0, &mut pcred) };
    println!("CredReadW result: {:?}", res3);
}

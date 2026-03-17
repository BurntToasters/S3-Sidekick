import { invoke } from "@tauri-apps/api/core";
import { showConfirm, showPrompt, showAlert } from "./dialogs.ts";

export interface SecurityStatus {
  initialized: boolean;
  encryption_enabled: boolean;
  unlocked: boolean;
  lock_timeout_minutes: number;
}

type StatusSetter = (text: string) => void;

async function getSecurityStatus(): Promise<SecurityStatus> {
  return invoke<SecurityStatus>("get_security_status");
}

async function initializeSecurity(
  enableEncryption: boolean,
  password: string | null,
): Promise<SecurityStatus> {
  return invoke<SecurityStatus>("initialize_security", {
    enableEncryption,
    password,
  });
}

async function unlockSecurity(password: string): Promise<SecurityStatus> {
  return invoke<SecurityStatus>("unlock_security", { password });
}

async function setSecurityEncryption(
  enableEncryption: boolean,
  currentPassword: string | null,
  newPassword: string | null,
): Promise<SecurityStatus> {
  return invoke<SecurityStatus>("set_security_encryption", {
    enableEncryption,
    currentPassword,
    newPassword,
  });
}

async function changeSecurityPassword(
  currentPassword: string,
  newPassword: string,
): Promise<SecurityStatus> {
  return invoke<SecurityStatus>("change_security_password", {
    currentPassword,
    newPassword,
  });
}

async function lockSecurity(): Promise<SecurityStatus> {
  return invoke<SecurityStatus>("lock_security");
}

async function setLockTimeoutMinutes(minutes: number): Promise<SecurityStatus> {
  return invoke<SecurityStatus>("set_lock_timeout", { minutes });
}

async function promptForNewPassword(): Promise<string | null> {
  const first = await showPrompt(
    "Set Password",
    "Set a password to encrypt saved credentials (AES-256):",
    { inputType: "password", inputPlaceholder: "Password (8+ characters)" },
  );
  if (first === null) return null;
  if (first.length < 8) {
    await showAlert(
      "Invalid Password",
      "Password must be at least 8 characters.",
    );
    return null;
  }

  const confirmed = await showPrompt(
    "Confirm Password",
    "Confirm your password:",
    {
      inputType: "password",
      inputPlaceholder: "Confirm password",
    },
  );
  if (confirmed === null) return null;
  if (first !== confirmed) {
    await showAlert("Password Mismatch", "Passwords do not match.");
    return null;
  }
  return first;
}

export async function ensureSecurityReady(): Promise<boolean> {
  let status: SecurityStatus;
  try {
    status = await getSecurityStatus();
  } catch (err) {
    await showAlert("Error", `Failed to read security status: ${err}`);
    return false;
  }

  if (!status.initialized) {
    const enableEncryption = await showConfirm(
      "Credential Encryption",
      "Enable credential encryption?\n\nRecommended: Yes.\nCredentials and bookmarks will be encrypted with AES-256 and protected by your password.",
      { okLabel: "Enable", cancelLabel: "Skip" },
    );

    if (enableEncryption) {
      const password = await promptForNewPassword();
      if (!password) {
        const continueUnencrypted = await showConfirm(
          "Continue?",
          "Encryption setup was canceled.\nContinue with unencrypted credential storage?",
        );
        if (!continueUnencrypted) return false;
        try {
          status = await initializeSecurity(false, null);
        } catch (err) {
          await showAlert("Error", `Failed to initialize security: ${err}`);
          return false;
        }
      } else {
        try {
          status = await initializeSecurity(true, password);
        } catch (err) {
          await showAlert("Error", `Failed to enable encryption: ${err}`);
          return false;
        }
      }
    } else {
      try {
        status = await initializeSecurity(false, null);
      } catch (err) {
        await showAlert("Error", `Failed to initialize security: ${err}`);
        return false;
      }
    }
  }

  if (!status.encryption_enabled) return true;
  if (status.unlocked) return true;

  while (true) {
    const password = await showPrompt(
      "Unlock",
      "Enter your password to unlock encrypted credentials:",
      { inputType: "password", inputPlaceholder: "Password" },
    );
    if (password === null) return false;
    if (!password) {
      await showAlert("Error", "Password is required.");
      continue;
    }

    try {
      status = await unlockSecurity(password);
      if (status.unlocked) return true;
    } catch (err) {
      await showAlert("Error", `Failed to unlock credentials: ${err}`);
    }
  }
}

export async function refreshSecuritySettingsUI(): Promise<void> {
  const statusText = document.getElementById("security-status-text");
  const toggleBtn = document.getElementById(
    "security-toggle",
  ) as HTMLButtonElement | null;
  const changeBtn = document.getElementById(
    "security-change-password",
  ) as HTMLButtonElement | null;
  const warning = document.getElementById("security-warning");
  const lockSettings = document.getElementById("security-lock-settings");
  const lockAction = document.getElementById("security-lock-action");
  const lockTimeoutSelect = document.getElementById(
    "security-lock-timeout",
  ) as HTMLSelectElement | null;
  if (!statusText || !toggleBtn || !changeBtn || !warning) return;

  try {
    const status = await getSecurityStatus();

    if (!status.initialized) {
      statusText.textContent = "Not initialized";
      toggleBtn.textContent = "Initialize Security";
      changeBtn.style.display = "none";
      warning.style.display = "";
      if (lockSettings) lockSettings.style.display = "none";
      if (lockAction) lockAction.style.display = "none";
    } else if (status.encryption_enabled) {
      if (status.unlocked) {
        statusText.textContent = "Encrypted (AES-256) and unlocked";
        toggleBtn.textContent = "Disable Encryption";
        changeBtn.style.display = "";
        if (lockSettings) lockSettings.style.display = "";
        if (lockAction) lockAction.style.display = "";
      } else {
        statusText.textContent = "Encrypted (locked)";
        toggleBtn.textContent = "Unlock";
        changeBtn.style.display = "none";
        if (lockSettings) lockSettings.style.display = "none";
        if (lockAction) lockAction.style.display = "none";
      }
      warning.style.display = "none";
      if (lockTimeoutSelect) {
        lockTimeoutSelect.value = String(status.lock_timeout_minutes);
      }
    } else {
      statusText.textContent = "Unencrypted";
      toggleBtn.textContent = "Enable Encryption";
      changeBtn.style.display = "none";
      warning.style.display = "";
      if (lockSettings) lockSettings.style.display = "none";
      if (lockAction) lockAction.style.display = "none";
    }
  } catch (err) {
    statusText.textContent = `Security status error: ${err}`;
    toggleBtn.disabled = true;
    changeBtn.disabled = true;
  }
}

export async function handleSecurityToggle(
  setStatus: StatusSetter,
): Promise<void> {
  let status: SecurityStatus;
  try {
    status = await getSecurityStatus();
  } catch (err) {
    await showAlert("Error", `Failed to read security status: ${err}`);
    return;
  }

  try {
    if (!status.initialized) {
      const enable = await showConfirm(
        "Initialize Security",
        "Security is not initialized yet. Enable encryption now?",
        { okLabel: "Enable", cancelLabel: "Skip" },
      );
      if (enable) {
        const password = await promptForNewPassword();
        if (!password) return;
        await initializeSecurity(true, password);
        setStatus("Credential encryption enabled.");
      } else {
        await initializeSecurity(false, null);
        setStatus("Security initialized without encryption.");
      }
      await refreshSecuritySettingsUI();
      return;
    }

    if (status.encryption_enabled && !status.unlocked) {
      const password = await showPrompt(
        "Unlock",
        "Enter your password to unlock encrypted credentials:",
        { inputType: "password", inputPlaceholder: "Password" },
      );
      if (password === null) return;
      if (!password) {
        await showAlert("Error", "Password is required.");
        return;
      }
      await unlockSecurity(password);
      setStatus("Credentials unlocked.");
    } else if (status.encryption_enabled) {
      const shouldDisable = await showConfirm(
        "Disable Encryption",
        "Disable encryption?\n\nSaved credentials and bookmarks will be stored unencrypted.",
        { okLabel: "Disable", okDanger: true },
      );
      if (!shouldDisable) return;

      const currentPassword = await showPrompt(
        "Current Password",
        "Enter your current password to decrypt stored credentials:",
        { inputType: "password", inputPlaceholder: "Current password" },
      );
      if (currentPassword === null) return;
      if (!currentPassword) {
        await showAlert("Error", "Current password is required.");
        return;
      }

      await setSecurityEncryption(false, currentPassword, null);
      setStatus(
        "Credential encryption disabled. Saved credentials are unencrypted.",
      );
    } else {
      const newPassword = await promptForNewPassword();
      if (!newPassword) return;

      await setSecurityEncryption(true, null, newPassword);
      setStatus("Credential encryption enabled.");
    }

    await refreshSecuritySettingsUI();
  } catch (err) {
    await showAlert("Error", `Security update failed: ${err}`);
  }
}

export async function handleSecurityChangePassword(
  setStatus: StatusSetter,
): Promise<void> {
  const currentPassword = await showPrompt(
    "Current Password",
    "Enter your current password:",
    { inputType: "password", inputPlaceholder: "Current password" },
  );
  if (currentPassword === null) return;
  if (!currentPassword) {
    await showAlert("Error", "Current password is required.");
    return;
  }

  const newPassword = await promptForNewPassword();
  if (!newPassword) return;

  try {
    await changeSecurityPassword(currentPassword, newPassword);
    setStatus("Credential encryption password updated.");
    await refreshSecuritySettingsUI();
  } catch (err) {
    await showAlert("Error", `Failed to change password: ${err}`);
  }
}

export async function handleLockNow(setStatus: StatusSetter): Promise<void> {
  try {
    await lockSecurity();
    setStatus("Encrypted storage locked.");
    await refreshSecuritySettingsUI();
  } catch (err) {
    await showAlert("Error", `Failed to lock: ${err}`);
  }
}

export async function handleLockTimeoutChange(): Promise<void> {
  const select = document.getElementById(
    "security-lock-timeout",
  ) as HTMLSelectElement | null;
  if (!select) return;

  try {
    await setLockTimeoutMinutes(Number(select.value));
  } catch (err) {
    await showAlert("Error", `Failed to set lock timeout: ${err}`);
  }
}

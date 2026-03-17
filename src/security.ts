import { invoke } from "@tauri-apps/api/core";

export interface SecurityStatus {
  initialized: boolean;
  encryption_enabled: boolean;
  unlocked: boolean;
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

function promptForNewPassword(): string | null {
  const first = window.prompt(
    "Set a password to encrypt saved credentials (AES-256):",
  );
  if (first === null) return null;
  if (first.length < 8) {
    window.alert("Password must be at least 8 characters.");
    return null;
  }

  const confirm = window.prompt("Confirm password:");
  if (confirm === null) return null;
  if (first !== confirm) {
    window.alert("Passwords do not match.");
    return null;
  }
  return first;
}

export async function ensureSecurityReady(): Promise<boolean> {
  let status: SecurityStatus;
  try {
    status = await getSecurityStatus();
  } catch (err) {
    window.alert(`Failed to read security status: ${err}`);
    return false;
  }

  if (!status.initialized) {
    const enableEncryption = window.confirm(
      "Enable credential encryption?\n\nRecommended: Yes.\nCredentials and bookmarks will be encrypted with AES-256 and protected by your password.",
    );

    if (enableEncryption) {
      const password = promptForNewPassword();
      if (!password) {
        const continueUnencrypted = window.confirm(
          "Encryption setup was canceled.\nContinue with unencrypted credential storage?",
        );
        if (!continueUnencrypted) return false;
        try {
          status = await initializeSecurity(false, null);
        } catch (err) {
          window.alert(`Failed to initialize security: ${err}`);
          return false;
        }
      } else {
        try {
          status = await initializeSecurity(true, password);
        } catch (err) {
          window.alert(`Failed to enable encryption: ${err}`);
          return false;
        }
      }
    } else {
      try {
        status = await initializeSecurity(false, null);
      } catch (err) {
        window.alert(`Failed to initialize security: ${err}`);
        return false;
      }
    }
  }

  if (!status.encryption_enabled) return true;
  if (status.unlocked) return true;

  while (true) {
    const password = window.prompt(
      "Enter your password to unlock encrypted credentials:",
    );
    if (password === null) return false;
    if (!password) {
      window.alert("Password is required.");
      continue;
    }

    try {
      status = await unlockSecurity(password);
      if (status.unlocked) return true;
    } catch (err) {
      window.alert(`Failed to unlock credentials: ${err}`);
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
  if (!statusText || !toggleBtn || !changeBtn || !warning) return;

  try {
    const status = await getSecurityStatus();

    if (!status.initialized) {
      statusText.textContent = "Not initialized";
      toggleBtn.textContent = "Initialize Security";
      changeBtn.style.display = "none";
      warning.style.display = "";
    } else if (status.encryption_enabled) {
      statusText.textContent = status.unlocked
        ? "Encrypted (AES-256) and unlocked"
        : "Encrypted (locked)";
      toggleBtn.textContent = "Disable Encryption";
      changeBtn.style.display = "";
      warning.style.display = "none";
    } else {
      statusText.textContent = "Unencrypted";
      toggleBtn.textContent = "Enable Encryption";
      changeBtn.style.display = "none";
      warning.style.display = "";
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
    window.alert(`Failed to read security status: ${err}`);
    return;
  }

  try {
    if (!status.initialized) {
      const enable = window.confirm(
        "Security is not initialized yet. Enable encryption now?",
      );
      if (enable) {
        const password = promptForNewPassword();
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

    if (status.encryption_enabled) {
      const shouldDisable = window.confirm(
        "Disable encryption?\n\nSaved credentials and bookmarks will be stored unencrypted.",
      );
      if (!shouldDisable) return;

      const currentPassword = window.prompt(
        "Enter your current password to decrypt stored credentials:",
      );
      if (currentPassword === null) return;
      if (!currentPassword) {
        window.alert("Current password is required.");
        return;
      }

      await setSecurityEncryption(false, currentPassword, null);
      setStatus(
        "Credential encryption disabled. Saved credentials are unencrypted.",
      );
    } else {
      const newPassword = promptForNewPassword();
      if (!newPassword) return;

      await setSecurityEncryption(true, null, newPassword);
      setStatus("Credential encryption enabled.");
    }

    await refreshSecuritySettingsUI();
  } catch (err) {
    window.alert(`Security update failed: ${err}`);
  }
}

export async function handleSecurityChangePassword(
  setStatus: StatusSetter,
): Promise<void> {
  const currentPassword = window.prompt("Enter current password:");
  if (currentPassword === null) return;
  if (!currentPassword) {
    window.alert("Current password is required.");
    return;
  }

  const newPassword = promptForNewPassword();
  if (!newPassword) return;

  try {
    await changeSecurityPassword(currentPassword, newPassword);
    setStatus("Credential encryption password updated.");
    await refreshSecuritySettingsUI();
  } catch (err) {
    window.alert(`Failed to change password: ${err}`);
  }
}

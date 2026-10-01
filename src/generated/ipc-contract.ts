// Generated from the registered Tauri commands by
// src-tauri/src/ipc_contract.rs. Do not edit by hand.
// Regenerate: UPDATE_IPC_CONTRACT=1 cargo test --manifest-path src-tauri/Cargo.toml ipc_contract

/** Argument object each native command accepts, keyed by command. */
export interface IpcCommandArgs {
  build_object_url: {
    connectionId: string;
    bucket: string;
    key: string;
  };
  cancel_transfer: {
    transferId: number;
  };
  change_security_password: {
    currentPassword: string;
    newPassword: string;
  };
  clear_saved_connection: Record<never, never>;
  clear_transfer_manifest: {
    recoverySession: string;
  };
  connect: {
    endpoint: string;
    region: string;
    accessKey: string;
    secretKey: string;
    sessionToken?: string | null;
  };
  copy_object_to: {
    connectionId: string;
    srcBucket: string;
    srcKey: string;
    dstBucket: string;
    dstKey: string;
    overwrite?: boolean | null;
    transferId?: number | null;
    requireImmutableSourceVersion?: boolean | null;
    automaticMove?: boolean | null;
  };
  copy_prefix_to: {
    connectionId: string;
    srcBucket: string;
    srcPrefix: string;
    dstBucket: string;
    dstPrefix: string;
    overwrite?: boolean | null;
    transferId?: number | null;
    collectReceipts?: boolean | null;
  };
  create_folder: {
    connectionId: string;
    bucket: string;
    key: string;
    overwrite?: boolean | null;
  };
  delete_copied_objects: {
    connectionId: string;
    srcBucket: string;
    dstBucket: string;
    receipts: unknown[];
    transferId?: number | null;
  };
  delete_objects: {
    connectionId: string;
    bucket: string;
    keys: string[];
  };
  delete_prefix: {
    connectionId: string;
    bucket: string;
    prefix: string;
  };
  disable_biometric: Record<never, never>;
  discard_download_scratch: {
    destination: string;
  };
  disconnect: {
    connectionId: string;
  };
  download_object: {
    connectionId: string;
    bucket: string;
    key: string;
    destination: string;
    transferId: number;
    overwrite: boolean;
    attempt?: number | null;
    checksumVerification?: boolean | null;
  };
  download_object_parallel: {
    connectionId: string;
    bucket: string;
    key: string;
    destination: string;
    transferId: number;
    overwrite: boolean;
    attempt?: number | null;
    parallelThresholdMb?: number | null;
    partSizeMb?: number | null;
    partConcurrency?: number | null;
    bandwidthLimitMbps?: number | null;
    checkpointId?: string | null;
    recoverySession: string;
    enableResume?: boolean | null;
    checksumVerification?: boolean | null;
  };
  enable_biometric: Record<never, never>;
  factory_reset: {
    settingsJson: string;
  };
  generate_presigned_url: {
    connectionId: string;
    bucket: string;
    key: string;
    expiresInSecs: number;
  };
  get_available_disk_bytes: {
    path: string;
  };
  get_object_acl: {
    connectionId: string;
    bucket: string;
    key: string;
  };
  get_platform_info: Record<never, never>;
  get_security_status: Record<never, never>;
  head_object: {
    connectionId: string;
    bucket: string;
    key: string;
  };
  initialize_security: {
    enableEncryption: boolean;
    password?: string | null;
  };
  is_app_translocated: Record<never, never>;
  list_buckets: {
    connectionId: string;
  };
  list_local_files_recursive: {
    roots: string[];
  };
  list_objects: {
    connectionId: string;
    bucket: string;
    prefix: string;
    delimiter: string;
    continuationToken: string;
  };
  load_bookmarks: Record<never, never>;
  load_bookmarks_backup: Record<never, never>;
  load_connection: Record<never, never>;
  load_settings: Record<never, never>;
  load_transfer_manifest: Record<never, never>;
  lock_security: Record<never, never>;
  object_exists: {
    connectionId: string;
    bucket: string;
    key: string;
  };
  open_external_url: {
    url: string;
  };
  open_local_path: {
    path: string;
  };
  path_exists: {
    path: string;
  };
  preview_object: {
    connectionId: string;
    bucket: string;
    key: string;
  };
  rename_object: {
    connectionId: string;
    bucket: string;
    oldKey: string;
    newKey: string;
    overwrite: boolean;
    transferId?: number | null;
  };
  rename_prefix: {
    connectionId: string;
    bucket: string;
    oldPrefix: string;
    newPrefix: string;
    overwrite: boolean;
    transferId?: number | null;
  };
  save_bookmarks: {
    json: string;
  };
  save_bookmarks_backup: {
    json: string;
  };
  save_connection: {
    connectionId: string;
    json: string;
  };
  save_settings: {
    json: string;
  };
  save_transfer_manifest: {
    json: string;
    recoverySession: string;
    legacyImport?: boolean | null;
  };
  set_lock_timeout: {
    minutes: number;
  };
  set_object_acl: {
    connectionId: string;
    bucket: string;
    key: string;
    visibility: string;
  };
  set_security_encryption: {
    enableEncryption: boolean;
    currentPassword?: string | null;
    newPassword?: string | null;
  };
  touch_security_activity: Record<never, never>;
  transfer_checkpoint_gc: {
    ttlHours: number;
    keepCheckpointIds?: string[] | null;
    recoverySession: string;
  };
  transfer_checkpoint_remove: {
    checkpointId: string;
    recoverySession: string;
  };
  unlock_biometric: Record<never, never>;
  unlock_security: {
    password: string;
  };
  update_metadata: {
    connectionId: string;
    bucket: string;
    key: string;
    contentType: string;
    metadata: unknown;
  };
  updater_support_info: Record<never, never>;
  updater_supported: Record<never, never>;
  upload_object: {
    connectionId: string;
    bucket: string;
    key: string;
    filePath: string;
    contentType: string;
    transferId: number;
    attempt?: number | null;
    overwrite?: boolean | null;
    partSizeMb?: number | null;
    partConcurrency?: number | null;
    bandwidthLimitMbps?: number | null;
    checksumVerification?: boolean | null;
  };
  upload_object_bytes: {
    connectionId: string;
    bucket: string;
    key: string;
    bytesBase64: string;
    contentType: string;
    transferId: number;
    attempt?: number | null;
    overwrite?: boolean | null;
    checksumVerification?: boolean | null;
  };
  write_text_file: {
    path: string;
    text: string;
    overwrite: boolean;
  };
}

export type IpcCommand = keyof IpcCommandArgs;

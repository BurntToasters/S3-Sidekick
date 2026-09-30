export interface CreateOnlyCapabilities {
  put_object: boolean;
  complete_multipart: boolean;
  copy_object: boolean;
}

export const FULL_CREATE_ONLY_CAPABILITIES: CreateOnlyCapabilities = {
  put_object: true,
  complete_multipart: true,
  copy_object: true,
};

export const NO_CREATE_ONLY_CAPABILITIES: CreateOnlyCapabilities = {
  put_object: false,
  complete_multipart: false,
  copy_object: false,
};

/** Matches `MULTIPART_THRESHOLD` in the Rust backend. */
export const MULTIPART_UPLOAD_THRESHOLD_BYTES = 128 * 1024 * 1024;

/** Matches `MULTIPART_COPY_THRESHOLD` in the Rust backend. */
export const MULTIPART_COPY_THRESHOLD_BYTES = 5_368_709_120;

export function lacksAtomicCreateForUpload(
  caps: CreateOnlyCapabilities,
  byteLength?: number,
): boolean {
  if (byteLength === undefined) {
    return !caps.put_object || !caps.complete_multipart;
  }
  if (byteLength >= MULTIPART_UPLOAD_THRESHOLD_BYTES) {
    return !caps.complete_multipart;
  }
  return !caps.put_object;
}

export function lacksAtomicCreateForCopy(
  caps: CreateOnlyCapabilities,
  byteLength?: number,
): boolean {
  if (byteLength === undefined) {
    return !caps.copy_object || !caps.complete_multipart;
  }
  if (byteLength >= MULTIPART_COPY_THRESHOLD_BYTES) {
    return !caps.complete_multipart;
  }
  return !caps.copy_object;
}

/**
 * Size to evaluate for a write whose bytes are not known up front but are
 * almost always small: folder markers (always zero bytes) and prefix
 * operations (per-object copies). The backend still fails closed for any
 * object it cannot guard; callers recover via `isCreateOnlyUnsupportedError`.
 */
export const SMALL_OBJECT_BYTE_LENGTH = 0;

/** The backend refused a create-only write this provider cannot enforce. */
export function isCreateOnlyUnsupportedError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /cannot enforce a create-only/i.test(message);
}

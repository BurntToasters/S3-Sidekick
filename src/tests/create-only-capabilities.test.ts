import { describe, expect, it } from "vitest";
import {
  lacksAtomicCreateForCopy,
  lacksAtomicCreateForUpload,
  MULTIPART_COPY_THRESHOLD_BYTES,
  MULTIPART_UPLOAD_THRESHOLD_BYTES,
} from "../create-only-capabilities.ts";

describe("create-only-capabilities", () => {
  const full = {
    put_object: true,
    complete_multipart: true,
    copy_object: true,
  };

  it("detects missing upload guards for DigitalOcean-style providers", () => {
    const spaces = {
      put_object: false,
      complete_multipart: false,
      copy_object: true,
    };
    expect(lacksAtomicCreateForUpload(spaces)).toBe(true);
    expect(lacksAtomicCreateForUpload(spaces, 1024)).toBe(true);
    expect(
      lacksAtomicCreateForUpload(spaces, MULTIPART_UPLOAD_THRESHOLD_BYTES),
    ).toBe(true);
    expect(lacksAtomicCreateForCopy(spaces, 1024)).toBe(false);
    expect(
      lacksAtomicCreateForCopy(spaces, MULTIPART_COPY_THRESHOLD_BYTES),
    ).toBe(true);
  });

  it("detects MinIO multipart gap without blocking small uploads", () => {
    const minio = {
      put_object: true,
      complete_multipart: false,
      copy_object: true,
    };
    expect(lacksAtomicCreateForUpload(minio, 1024)).toBe(false);
    expect(
      lacksAtomicCreateForUpload(minio, MULTIPART_UPLOAD_THRESHOLD_BYTES),
    ).toBe(true);
    expect(lacksAtomicCreateForCopy(minio, 1024)).toBe(false);
    expect(
      lacksAtomicCreateForCopy(minio, MULTIPART_COPY_THRESHOLD_BYTES),
    ).toBe(true);
  });

  it("treats fully supported providers as atomic", () => {
    expect(lacksAtomicCreateForUpload(full, 1024)).toBe(false);
    expect(
      lacksAtomicCreateForUpload(full, MULTIPART_UPLOAD_THRESHOLD_BYTES),
    ).toBe(false);
    expect(lacksAtomicCreateForCopy(full, MULTIPART_COPY_THRESHOLD_BYTES)).toBe(
      false,
    );
  });
});

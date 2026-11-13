export interface ReleaseIdentity {
  version: string;
  commit: string;
  platform: string;
  arch: string;
  node: string;
  rustc: string;
  packageLockSha256: string;
  cargoLockSha256: string;
  sourceTreeSha256: string;
}

export interface ReleaseSession extends ReleaseIdentity {
  qualityGateCompletedAt: number;
  startedAt: number;
}

export interface QualityGateEvidence {
  path: string;
  sha256: string;
}

export interface QualityGateProof extends ReleaseIdentity {
  completedAt: number;
  evidenceCompletedAt: number;
  evidence: QualityGateEvidence[];
}

export const DEFAULT_MAX_AGE_MS: number;
export const QUALITY_GATE_EVIDENCE_RELATIVE_PATH: string;
export const QUALITY_GATE_RELATIVE_PATH: string;
export const QUALITY_GATE_REPORT_SPECS: ReadonlyArray<{
  path: string;
  kind: string;
  platforms: ReadonlyArray<string> | null;
}>;
export const RELEASE_SESSION_RELATIVE_PATH: string;
export const RELEASE_BOOTSTRAP_PATHS: Set<string>;
export const REQUIRED_QUALITY_CHECK_NAMES: ReadonlyArray<string>;

export function activeQualityGateReportSpecs(
  platform?: string,
): ReadonlyArray<{
  path: string;
  kind: string;
  platforms: ReadonlyArray<string> | null;
}>;
export function requiredQualityCheckNames(
  platform?: string,
): ReadonlyArray<string>;

export function currentReleaseIdentity(root?: string): ReleaseIdentity;
export function sha256WorkingTree(root?: string): string;
export function createReleaseSession(root?: string): ReleaseSession;
export function startReleaseSession(root?: string): ReleaseSession;
export function clearQualityGateEvidence(root?: string): void;
export function clearQualityGateProof(root?: string): void;
export function writeQualityGateEvidence(
  root: string,
  evidence: {
    commit: string;
    startedAt: number;
    completedAt: number;
    checks: Record<string, { status: string }>;
    passed: boolean;
    workingTreeSha256Start: string;
    workingTreeSha256End: string;
  },
): string;
export function qualityGateEvidenceProblems(
  root?: string,
  options?: { now?: number; maxAgeMs?: number; commit?: string },
): {
  problems: string[];
  evidence: {
    commit: string;
    startedAt: number;
    completedAt: number;
    passed: boolean;
    workingTreeSha256Start: string;
    workingTreeSha256End: string;
    checks: Record<string, { status: string }>;
  } | null;
  evidenceSha256: string | null;
  reports: Array<{ path: string; sha256: string; completedAt: number }>;
};
export function recordSuccessfulQualityGate(root?: string): boolean;
export function gitPorcelainStatus(root?: string): string;
export function parsePorcelainPaths(status: string): string[];
export function isAcceptableReleaseWorkingTree(status: string): boolean;
export function blockingReleaseWorkingTreePaths(root?: string): string[];
export function validateQualityGate(
  proof: QualityGateProof,
  expected: ReleaseIdentity,
  options?: { now?: number; maxAgeMs?: number },
): QualityGateProof;
export function verifyQualityGate(
  root?: string,
  options?: { now?: number; maxAgeMs?: number },
): QualityGateProof;
export function validateReleaseSession(
  session: ReleaseSession,
  expected: ReleaseIdentity,
  options?: { now?: number; maxAgeMs?: number },
): ReleaseSession;
export function verifyReleaseSession(
  root?: string,
  options?: { now?: number; maxAgeMs?: number },
): ReleaseSession;

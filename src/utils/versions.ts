// Default install target and oldest supported CLI are independent: newer
// defaults must not invalidate an otherwise compatible existing sandbox.
export const NEMOCLAW_VERSION = 'v0.0.139';
export const MIN_NEMOCLAW_VERSION = 'v0.0.134';
export const MIN_NODE_VERSION = '22.19.0';
export const MIN_OPENCLAW_VERSION = '2026.9.2';
// Host installation resolves an available Node 24 release, independent of the image.
export const DEFAULT_NODE_VERSION = '24';
export const OPENCLAW_NODE_RANGE = '>=22.22.3 <23 || >=24.15.0 <25 || >=25.9.0';

/** Match the exact engines.node contract of the OpenClaw runtime pinned by NemoClaw. */
export function assertOpenClawNodeVersion(output: string): string {
  const version = output.match(/\bv?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)\b/)?.[1];
  const parsed = version ? parseSemanticVersion(version) : undefined;
  const major = parsed?.core[0];
  const supported = parsed && parsed.prerelease.length === 0 && (
    (major === 22 && !isInstalledVersionLower(version, '22.22.3')) ||
    (major === 24 && !isInstalledVersionLower(version, '24.15.0')) ||
    (major! >= 25 && !isInstalledVersionLower(version, '25.9.0'))
  );
  if (!supported) {
    throw new Error(`sandbox Node.js 版本不满足 OpenClaw 要求：${version ?? '无法识别'}，需要 ${OPENCLAW_NODE_RANGE}。`);
  }
  return version!;
}

export function assertMinimumVersion(output: string, minimum: string, label: string): string {
  const version = output.match(/\bv?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)\b/)?.[1];
  if (!version || isInstalledVersionLower(version, minimum)) {
    throw new Error(`${label} 版本不满足要求：${version ?? '无法识别'}，需要 >= ${minimum}。请先更新对应运行环境。`);
  }
  return version;
}

export function isInstalledVersionLower(
  installedVersion: string | undefined,
  targetVersion: string
): boolean {
  if (!installedVersion) return false;
  const installed = parseSemanticVersion(installedVersion);
  const target = parseSemanticVersion(targetVersion);
  if (!installed || !target) return false;
  return compareSemanticVersions(installed, target) < 0;
}

export function normalizeVersion(version: string): string | undefined {
  const trimmed = version.trim();
  const match = trimmed.match(/^v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/);
  return match ? `v${match[1]}` : undefined;
}

interface SemanticVersion {
  core: [number, number, number];
  prerelease: string[];
}

function parseSemanticVersion(value: string): SemanticVersion | undefined {
  const normalized = normalizeVersion(value);
  if (!normalized) return undefined;
  const match = normalized.match(
    /^v(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/
  );
  if (!match) return undefined;
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4]?.split('.') ?? []
  };
}

function compareSemanticVersions(left: SemanticVersion, right: SemanticVersion): number {
  for (let index = 0; index < left.core.length; index += 1) {
    if (left.core[index] !== right.core[index]) {
      return left.core[index] < right.core[index] ? -1 : 1;
    }
  }

  if (left.prerelease.length === 0 && right.prerelease.length === 0) return 0;
  if (left.prerelease.length === 0) return 1;
  if (right.prerelease.length === 0) return -1;

  const length = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = left.prerelease[index];
    const rightPart = right.prerelease[index];
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;
    if (leftPart === rightPart) continue;

    const leftNumeric = /^\d+$/.test(leftPart);
    const rightNumeric = /^\d+$/.test(rightPart);
    if (leftNumeric && rightNumeric) return Number(leftPart) < Number(rightPart) ? -1 : 1;
    if (leftNumeric) return -1;
    if (rightNumeric) return 1;
    return leftPart < rightPart ? -1 : 1;
  }
  return 0;
}

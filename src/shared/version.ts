export function isReleaseVersion(value: unknown): value is string {
  return typeof value === "string" && /^\d+\.\d+\.\d+$/.test(value);
}

export function compareVersions(a: string, b: string): number {
  const left = a.split(".").map(Number);
  const right = b.split(".").map(Number);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const diff = (left[i] || 0) - (right[i] || 0);
    if (diff) return Math.sign(diff);
  }
  return 0;
}

export const VERSION = '1.0.0-rc.5';

/** Semver precedence prevents old and new MCP clients from downgrading each other's daemon. */
export function compareVersions(a: string, b: string): number {
  const parse = (s: string) => {
    const match = /^(\d+)\.(\d+)\.(\d+)(?:-([\w.-]+))?(?:\+[\w.-]+)?$/.exec(s);
    if (!match) throw new Error('Unsupported Nexo runtime version: ' + s);
    return { core: match.slice(1, 4).map(Number), pre: match[4]?.split('.') };
  };
  const x = parse(a),
    y = parse(b);
  for (let i = 0; i < 3; i++) if (x.core[i] !== y.core[i]) return x.core[i] - y.core[i];
  if (!x.pre || !y.pre) return x.pre ? -1 : y.pre ? 1 : 0;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const left = x.pre[i],
      right = y.pre[i];
    if (left === right) continue;
    if (left === undefined || right === undefined) return left === undefined ? -1 : 1;
    const ln = /^\d+$/.test(left),
      rn = /^\d+$/.test(right);
    if (ln && rn) {
      const difference = Number(left) - Number(right);
      if (difference) return difference;
      continue;
    }
    if (ln !== rn) return ln ? -1 : 1;
    return left < right ? -1 : 1;
  }
  return 0;
}

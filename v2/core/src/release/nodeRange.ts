type Version = [number, number, number];

function parseVersion(text: string, fill: number): Version | null {
  const match = /^v?(\d+|x|\*)(?:\.(\d+|x|\*))?(?:\.(\d+|x|\*))?$/i.exec(text.trim());
  if (!match) return null;
  const part = (value: string | undefined): number => value === undefined || /^[x*]$/i.test(value) ? fill : Number(value);
  return [part(match[1]), part(match[2]), part(match[3])];
}

function compare(a: Version, b: Version): number {
  for (let i = 0; i < 3; i += 1) if (a[i] !== b[i]) return a[i]! < b[i]! ? -1 : 1;
  return 0;
}

type Comparator = (version: Version) => boolean;

function comparator(token: string): Comparator | null {
  const match = /^(>=|<=|>|<|=|\^|~)?\s*(.+)$/.exec(token);
  if (!match) return null;
  const operator = match[1] ?? "", rest = match[2]!;
  const exact = parseVersion(rest, 0);
  if (!exact) return null;
  const partial = /^v?(\d+|x|\*)(?:\.(\d+|x|\*))?(?:\.(\d+|x|\*))?$/i.exec(rest.trim())!;
  const given = [partial[1], partial[2], partial[3]].filter((value) => value !== undefined && !/^[x*]$/i.test(value)).length;
  const upper = (): Version => given <= 1 ? [exact[0] + 1, 0, 0] : given === 2 ? [exact[0], exact[1] + 1, 0] : [exact[0], exact[1], exact[2] + 1];
  switch (operator) {
    case ">=": return (version) => compare(version, exact) >= 0;
    case ">": return given === 3 ? (version) => compare(version, exact) > 0 : (version) => compare(version, upper()) >= 0;
    case "<": return (version) => compare(version, exact) < 0;
    case "<=": return given === 3 ? (version) => compare(version, exact) <= 0 : (version) => compare(version, upper()) < 0;
    case "^": {
      const top: Version = exact[0] > 0 ? [exact[0] + 1, 0, 0] : exact[1] > 0 ? [0, exact[1] + 1, 0] : [0, 0, exact[2] + 1];
      return (version) => compare(version, exact) >= 0 && compare(version, top) < 0;
    }
    case "~": {
      const top: Version = given === 1 ? [exact[0] + 1, 0, 0] : [exact[0], exact[1] + 1, 0];
      return (version) => compare(version, exact) >= 0 && compare(version, top) < 0;
    }
    default: return given === 3 ? (version) => compare(version, exact) === 0 : (version) => compare(version, exact) >= 0 && compare(version, upper()) < 0;
  }
}

function rangeSet(text: string): Comparator | null {
  const trimmed = text.trim();
  if (trimmed === "" || trimmed === "*" || /^x$/i.test(trimmed)) return () => true;
  const hyphen = /^(\S+)\s+-\s+(\S+)$/.exec(trimmed);
  if (hyphen) {
    const low = comparator(`>=${hyphen[1]}`), high = comparator(`<=${hyphen[2]}`);
    return low && high ? (version) => low(version) && high(version) : null;
  }
  const tokens = trimmed.replace(/(>=|<=|>|<|=|\^|~)\s+/g, "$1").split(/\s+/);
  const comparators: Comparator[] = [];
  for (const token of tokens) {
    const parsed = comparator(token);
    if (!parsed) return null;
    comparators.push(parsed);
  }
  return (version) => comparators.every((check) => check(version));
}

export function satisfiesNodeRange(version: string, range: string): boolean {
  const parsed = parseVersion(version, 0);
  if (!parsed || !/^v?\d+\.\d+\.\d+$/.test(version.trim())) throw new Error(`invalid Node version ${version}`);
  const alternatives = range.split("||").map(rangeSet);
  if (alternatives.some((alternative) => alternative === null)) throw new Error(`invalid engines.node range ${range}`);
  return alternatives.some((alternative) => alternative!(parsed));
}

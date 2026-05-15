export interface BashGuardrailDecision {
  allowed: boolean;
  reason?: string;
  decodedPayload?: string;
}

const ENABLED_VALUES = new Set(["1", "true", "yes", "on", "strict"]);

export function bashGuardrailsEnabled(): boolean {
  const value =
    process.env.LETTA_BASH_GUARDRAILS ?? process.env.LETTA_GUARDRAILS ?? "";
  return ENABLED_VALUES.has(value.trim().toLowerCase());
}

const HOMOGRAPH_MAP: Record<string, string> = {
  а: "a",
  е: "e",
  о: "o",
  р: "p",
  с: "c",
  у: "y",
  х: "x",
  Α: "A",
  Β: "B",
  Ε: "E",
  Ζ: "Z",
  Η: "H",
  Ι: "I",
  Κ: "K",
  Μ: "M",
  Ν: "N",
  Ο: "O",
  Ρ: "P",
  Τ: "T",
  Χ: "X",
};

function normalizeHomographs(value: string): string {
  return value.replace(
    /[аоерсухΑΒΕΖΗΙΚΜΝΟΡΤΧ]/g,
    (char) => HOMOGRAPH_MAP[char] ?? char,
  );
}

const DANGEROUS_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  {
    pattern: /:\s*\(\)\s*\{\s*:\s*\|\s*:\s*&\s*}\s*;\s*:/,
    reason: "fork bomb pattern",
  },
  {
    pattern:
      /\brm\s+(-[rfiv]*[rf][rfiv]*\s+|.*\s--no-preserve-root\s+)(?:\/|\$\{?HOME\}?|~)(?:\s|$)/i,
    reason: "destructive recursive remove",
  },
  {
    pattern:
      /\b(?:curl|wget)\b[\s\S]{0,300}\|\s*(?:sudo\s+)?(?:sh|bash|zsh|python|perl|ruby)\b/i,
    reason: "downloaded script piped into an interpreter",
  },
  {
    pattern:
      /\b(?:nc|ncat|netcat|bash|sh)\b[\s\S]{0,240}(?:\/dev\/tcp|\b-e\s+\/bin\/|\b-e\s+bash|\bmkfifo\b)/i,
    reason: "reverse-shell-like command",
  },
  {
    pattern: /\bchmod\s+777\s+(?:\/|\.\.|~)/i,
    reason: "broad dangerous permission change",
  },
  {
    pattern: /\bdd\s+if=\/dev\/(?:zero|random|urandom)\s+of=\/dev\//i,
    reason: "raw device overwrite",
  },
];

function findDangerousPattern(command: string): string | undefined {
  const normalized = normalizeHomographs(command);
  for (const { pattern, reason } of DANGEROUS_PATTERNS) {
    if (pattern.test(normalized)) return reason;
  }
  return undefined;
}

function tryDecodeBase64(candidate: string): string | undefined {
  const normalized = candidate.replace(/\s+/g, "");
  if (normalized.length < 24 || normalized.length > 12000) return undefined;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(normalized)) return undefined;
  try {
    const decoded = Buffer.from(normalized, "base64").toString("utf8");
    const printable = decoded.replace(/[\t\n\r -~]/g, "").length;
    if (!decoded.trim() || printable > Math.max(3, decoded.length * 0.1)) {
      return undefined;
    }
    return decoded;
  } catch {
    return undefined;
  }
}

export function checkBashCommandGuardrails(
  command: string,
): BashGuardrailDecision {
  if (!bashGuardrailsEnabled()) return { allowed: true };

  const directReason = findDangerousPattern(command);
  if (directReason) return { allowed: false, reason: directReason };

  for (const match of command.matchAll(/[A-Za-z0-9+/]{24,}={0,2}/g)) {
    const decoded = tryDecodeBase64(match[0]);
    if (!decoded) continue;
    const decodedReason = findDangerousPattern(decoded);
    if (decodedReason) {
      return {
        allowed: false,
        reason: `base64-encoded ${decodedReason}`,
        decodedPayload: decoded.slice(0, 500),
      };
    }
  }

  return { allowed: true };
}

export function formatBashGuardrailRejection(
  decision: BashGuardrailDecision,
): string {
  const payload = decision.decodedPayload
    ? `\nDecoded payload preview:\n${decision.decodedPayload}`
    : "";
  return `Command blocked by Letta Bash guardrails: ${decision.reason ?? "unsafe command"}.${payload}\nIf this is intentional, review it carefully and rerun with LETTA_BASH_GUARDRAILS=0 for this command.`;
}

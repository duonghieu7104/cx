const TOKEN_PATTERNS: RegExp[] = [
  /ghp_[A-Za-z0-9]{8,}/g,
  /gho_[A-Za-z0-9]{8,}/g,
  /github_pat_[A-Za-z0-9_]{8,}/g,
  /sk-[A-Za-z0-9]{8,}/g,
  /Bearer\s+[A-Za-z0-9._\-+/=]{8,}/gi,
  /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
];

const ASSIGNMENT =
  /\b([A-Z0-9_]*(?:PASSWORD|SECRET|TOKEN|API_KEY|PRIVATE_KEY)[A-Z0-9_]*)=([^\s'";]+)/gi;

export function redact(text: string): string {
  let out = text;
  for (const pattern of TOKEN_PATTERNS) {
    out = out.replace(pattern, '[redacted]');
  }
  out = out.replace(ASSIGNMENT, (_all, name: string) => `${name}=[redacted]`);
  return out;
}

export function redactJson(value: unknown): string {
  return redact(JSON.stringify(value, null, 2));
}

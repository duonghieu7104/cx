export interface ConfigIssue {
  file: string;
  path: string;
  message: string;
  line?: number;
}

export class CxError extends Error {
  readonly exitCode: number;

  constructor(message: string, exitCode = 1) {
    super(message);
    this.name = 'CxError';
    this.exitCode = exitCode;
  }
}

export class ConfigError extends CxError {
  readonly issues: ConfigIssue[];

  constructor(issues: ConfigIssue[]) {
    super(formatIssues(issues));
    this.name = 'ConfigError';
    this.issues = issues;
  }
}

export function formatIssues(issues: ConfigIssue[]): string {
  if (issues.length === 0) return 'invalid config';
  return issues
    .map((issue) => {
      const loc = issue.line ? `${issue.file}:${issue.line}` : issue.file;
      const path = issue.path ? `${issue.path}: ` : '';
      return `${loc}: ${path}${issue.message}`;
    })
    .join('\n');
}

export interface Diagnostic {
  code: string;
  message: string;
  path?: string;
  line?: number;
  severity?: 'error' | 'warning';
  hint?: string;
}

export class WorkflowError extends Error {
  constructor(public code: string, message: string, public exitCode = 2, public details?: unknown) {
    super(message);
    this.name = 'WorkflowError';
  }
}

export function assert(condition: unknown, code: string, message: string, exitCode = 2): asserts condition {
  if (!condition) throw new WorkflowError(code, message, exitCode);
}

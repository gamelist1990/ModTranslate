export type JarFile = { name: string; abs_path: string };

export type PlanSummary = {
  total: number;
  skipped_in_jar: number;
  plan_errors: number;
  broken_target_found: number;
  repaired_target: number;
  backup_created: number;
  repair_errors: number;
};

export type PlanResult = {
  summary: PlanSummary;
  tasks: Array<{
    jar_path: string;
    jar_name: string;
    namespace: string;
    src_path: string;
    dst_path: string;
  }>;
};

export type ProgressEvent = {
  runId: string;
  doneMods: number;
  totalMods: number;
  translated: number;
  skipped: number;
  errors: number;
  current: string;
  keyTotal: number;
  keyDone: number;
  keyNote: string;
};

export type LogEvent = { runId: string; line: string };

export type DoneEvent = {
  runId: string;
  aborted: boolean;
  summary: PlanSummary;
  translated: number;
  skipped: number;
  errors: number;
  outDir: string;
  elapsedMs: number;
};

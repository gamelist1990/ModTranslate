import readline from "node:readline";
import Table from "cli-table3";
import logUpdate from "log-update";
import chalk from "chalk";
import stripAnsi from "strip-ansi";
import stringWidth from "string-width";

export type RunScreenStats = {
  totalMods: number;
  doneMods: number;
  translated: number;
  skipped: number;
  errors: number;
  current: string;

  keyTotal: number;
  keyDone: number;
  keyNote: string;
};

export type RunScreenController = {
  update: (patch: Partial<RunScreenStats>) => void;
  log: (line: string) => void;
  finish: (line?: string) => Promise<void>;
  requestAbort: () => void;
  isAborted: () => boolean;
  stop: () => void;
};

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function rate(done: number, ms: number): number {
  if (ms <= 0) return 0;
  return done / (ms / 1000);
}

function etaMs(done: number, total: number, ms: number): number | null {
  if (done <= 0) return null;
  if (done >= total) return 0;
  const r = done / ms;
  if (r <= 0) return null;
  return (total - done) / r;
}

function renderBar(width: number, ratio: number): string {
  const w = clamp(width, 10, 80);
  const filled = clamp(Math.round(w * clamp(ratio, 0, 1)), 0, w);
  return "█".repeat(filled) + "░".repeat(w - filled);
}

function singleLine(s: string): string {
  return s.replace(/[\r\n]+/g, " ").trim();
}

function truncateToWidth(input: string, maxWidth: number): string {
  const max = clamp(Math.floor(maxWidth), 4, 400);
  const plain = stripAnsi(String(input));
  if (stringWidth(plain) <= max) return plain;

  const ellipsis = "…";
  const target = Math.max(1, max - stringWidth(ellipsis));
  let out = "";
  let w = 0;
  for (const ch of plain) {
    const cw = stringWidth(ch);
    if (w + cw > target) break;
    out += ch;
    w += cw;
  }
  return out + ellipsis;
}

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

const ESC = "\u001b[";
function hideCursor() {
  process.stdout.write(`${ESC}?25l`);
}
function showCursor() {
  process.stdout.write(`${ESC}?25h`);
}

export function createRunScreenAnsi(initial: RunScreenStats): RunScreenController {
  let stats: RunScreenStats = { ...initial };
  let logs: string[] = [];
  let aborted = false;
  let done = false;
  const startedAt = Date.now();
  let interval: ReturnType<typeof setInterval> | undefined;
  let rawModeEnabled = false;
  let stopped = false;
  let cursorHidden = false;

  const onKeypress = (_str: string, key: any) => {
    if (key?.ctrl && key?.name === "c") {
      aborted = true;
    }
  };

  const draw = () => {
    const cols = process.stdout.columns ?? 120;
    const rows = process.stdout.rows ?? 40;
    const elapsed = Date.now() - startedAt;

    const modsRatio = stats.totalMods > 0 ? stats.doneMods / stats.totalMods : 0;
    const keysRatio = stats.keyTotal > 0 ? stats.keyDone / stats.keyTotal : 0;
    const modsEta = etaMs(stats.doneMods, stats.totalMods, Math.max(1, elapsed));
    const keysEta = etaMs(stats.keyDone, stats.keyTotal, Math.max(1, elapsed));
    const modsRate = rate(stats.doneMods, elapsed);
    const keysRate = rate(stats.keyDone, Math.max(1, elapsed));

    if (!cursorHidden) {
      hideCursor();
      cursorHidden = true;
    }

    const state = done ? "DONE" : aborted ? "ABORTING" : "RUNNING";
    const stateColored =
      state === "DONE"
        ? chalk.bold.green(state)
        : state === "ABORTING"
          ? chalk.bold.yellow(state)
          : chalk.bold.cyan(state);

    // Layout widths
    const keyColW = 10;
    const padding = 6; // table borders + spacing
    const valColW = clamp(cols - keyColW - padding, 20, 200);
    const barW = clamp(valColW - 34, 10, 60);

    const status = new Table({
      colWidths: [keyColW, valColW],
      wordWrap: true,
      style: { head: [], border: [], compact: true },
    });

    const modsBar = chalk.cyan(renderBar(barW, modsRatio));
    const keysBar = chalk.magenta(renderBar(barW, keysRatio));
    const tStr = chalk.green(String(stats.translated));
    const sStr = chalk.gray(String(stats.skipped));
    const eStr = stats.errors > 0 ? chalk.red.bold(String(stats.errors)) : chalk.gray("0");
    const nowPlain = stats.current && stats.current !== "-" ? singleLine(stats.current) : "-";
    const notePlain = stats.keyNote && stats.keyNote !== "-" ? singleLine(stats.keyNote) : "-";
    const nowStr = nowPlain !== "-" ? chalk.white(truncateToWidth(nowPlain, valColW - 2)) : chalk.gray("-");
    const noteStr = notePlain !== "-" ? chalk.gray(truncateToWidth(notePlain, valColW - 2)) : chalk.gray("-");

    const modsLine = `${modsBar}  ${chalk.bold(`${stats.doneMods}/${stats.totalMods}`)}  ` +
      `T:${tStr} S:${sStr} E:${eStr}`;
    const keysLine = `${keysBar}  ${chalk.bold(`${stats.keyDone}/${stats.keyTotal}`)}`;

    status.push(
      ["State", `${stateColored}`],
      ["Elapsed", chalk.gray(formatDuration(elapsed))],
      [
        "Mods",
        modsLine,
      ],
      [
        "ModsRate",
        `${chalk.gray(modsRate.toFixed(2))} ${chalk.gray("mods/s")}  ${chalk.gray("ETA:")}${
          modsEta === null ? chalk.gray("-") : chalk.gray(formatDuration(modsEta))
        }`,
      ],
      ["Keys", keysLine],
      [
        "KeysRate",
        `${chalk.gray(keysRate.toFixed(2))} ${chalk.gray("keys/s")}  ${chalk.gray("ETA:")}${
          keysEta === null ? chalk.gray("-") : chalk.gray(formatDuration(keysEta))
        }`,
      ],
      ["Now", nowStr],
      ["Note", noteStr],
    );

    const logHeight = clamp(rows - 18, 6, 30);
    const tail = logs.slice(Math.max(0, logs.length - logHeight));

    const logColW = clamp(cols - 4, 20, 240);
    const logTable = new Table({
      head: [`Log (last ${tail.length}/${logs.length})`],
      colWidths: [logColW],
      wordWrap: true,
      style: { head: [], border: [], compact: true },
    });
    if (tail.length === 0) {
      logTable.push(["-"]);
    } else {
      for (const line of tail) {
        const plain = truncateToWidth(singleLine(line), logColW - 2);
        logTable.push([plain]);
      }
    }

    const hint = done ? chalk.gray("(自動で閉じます)") : chalk.gray("(Ctrl+Cで中断)");

    const out = `${status.toString()}\n\n${logTable.toString()}\n\n${hint}`;
    logUpdate(out);
  };

  // Setup keypress
  readline.emitKeypressEvents(process.stdin);
  if (process.stdin.isTTY) {
    try {
      process.stdin.setRawMode(true);
      rawModeEnabled = true;
    } catch {
      // ignore
    }
  }
  process.stdin.on("keypress", onKeypress);
  process.stdin.resume();

  interval = setInterval(draw, 200);
  draw();

  const stop = () => {
    if (stopped) return;
    stopped = true;
    if (interval) clearInterval(interval);
    process.stdin.off("keypress", onKeypress);
    if (rawModeEnabled) {
      try {
        process.stdin.setRawMode(false);
      } catch {
        // ignore
      }
    }
    try {
      logUpdate.done();
    } catch {
      // ignore
    }
    if (cursorHidden) showCursor();
    process.stdout.write("\n");
  };

  return {
    update: (patch) => {
      stats = { ...stats, ...patch };
      draw();
    },
    log: (line) => {
      logs = [...logs, singleLine(line)];
      if (logs.length > 300) logs = logs.slice(logs.length - 300);
      draw();
    },
    finish: async (line) => {
      done = true;
      if (line) logs = [...logs, line];
      draw();
      const autoCloseMsRaw = Bun.env.MODTRANSLATE_RUN_UI_AUTOCLOSE_MS ?? "1500";
      const autoCloseMs = Number(autoCloseMsRaw);
      if (Number.isFinite(autoCloseMs) && autoCloseMs > 0) {
        await sleep(autoCloseMs);
      }
      stop();
    },
    requestAbort: () => {
      aborted = true;
      draw();
    },
    isAborted: () => aborted,
    stop,
  };
}

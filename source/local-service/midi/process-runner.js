import { spawn } from "node:child_process";

const DEFAULT_TIMEOUT_MS = 60 * 60 * 1_000;
const DEFAULT_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

export class ProcessExecutionError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "ProcessExecutionError";
    this.code = code;
    Object.assign(this, details);
  }
}

export function runProcess(command, args, options = {}) {
  if (typeof command !== "string" || !command) throw new TypeError("command must be a non-empty string");
  if (!Array.isArray(args) || args.some(value => typeof value !== "string")) {
    throw new TypeError("process arguments must be a string array");
  }
  if (options.signal?.aborted) {
    return Promise.reject(new ProcessExecutionError("PROCESS_ABORTED", "Process was cancelled before start"));
  }

  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let requestedFailure = null;
    const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;

    function append(stream, chunk) {
      const text = chunk.toString("utf8");
      options.onOutput?.({ stream, chunk: text });
      if (stream === "stdout") stdout = `${stdout}${text}`.slice(-maxOutputBytes);
      else stderr = `${stderr}${text}`.slice(-maxOutputBytes);
    }

    child.stdout.on("data", chunk => append("stdout", chunk));
    child.stderr.on("data", chunk => append("stderr", chunk));

    function requestStop(error) {
      if (settled || requestedFailure) return;
      requestedFailure = error;
      child.kill();
    }

    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const timer = setTimeout(() => {
      requestStop(new ProcessExecutionError(
        "PROCESS_TIMEOUT",
        `${command} exceeded ${timeoutMs} ms`,
        { command, args, stdout, stderr },
      ));
    }, timeoutMs);
    timer.unref?.();

    const onAbort = () => requestStop(new ProcessExecutionError(
      "PROCESS_ABORTED",
      `${command} was cancelled`,
      { command, args, stdout, stderr },
    ));
    options.signal?.addEventListener("abort", onAbort, { once: true });

    function cleanup() {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
    }

    child.once("error", error => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new ProcessExecutionError(
        "PROCESS_START_FAILED",
        `${command} could not start: ${error.message}`,
        { command, args, cause: error, stdout, stderr },
      ));
    });

    child.once("close", (exitCode, signal) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (requestedFailure) {
        requestedFailure.stdout = stdout;
        requestedFailure.stderr = stderr;
        reject(requestedFailure);
        return;
      }
      if (exitCode !== 0) {
        reject(new ProcessExecutionError(
          "PROCESS_EXIT_FAILED",
          stderr.trim() || `${command} exited with code ${exitCode ?? signal}`,
          { command, args, exitCode, signal, stdout, stderr },
        ));
        return;
      }
      resolvePromise({ command, args, exitCode, stdout, stderr });
    });
  });
}


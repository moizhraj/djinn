import * as vscode from 'vscode';

export interface SpawnedAgentTerminal {
  terminal: vscode.Terminal;
  /**
   * Resolves when the agent command finishes. `exitCode` is the command's exit
   * code when shell integration is available; otherwise it falls back to the
   * terminal's exit status (only known when the terminal closes). `output` is
   * the captured stdout/stderr stream when shell integration is available; an
   * empty string otherwise.
   */
  done: Promise<{ exitCode: number | undefined; output: string }>;
  /**
   * Returns the captured output buffer at the time of the call. Useful for
   * callers that detect completion via a side channel (e.g. a Stop hook
   * sentinel file) before `done` resolves.
   */
  getOutput(): string;
}

/**
 * Open an integrated terminal, run a command, and resolve when the command
 * finishes. Prefers VS Code's shell integration so we don't have to wait for
 * the user to close the terminal to know the agent is done.
 */
export function spawnAgentTerminal(
  name: string,
  cwd: vscode.Uri,
  command: string,
  env?: Record<string, string>
): SpawnedAgentTerminal {
  const terminal = vscode.window.createTerminal({ name, cwd, env });
  terminal.show(true);

  let buffered = '';

  const done = new Promise<{ exitCode: number | undefined; output: string }>(resolve => {
    let settled = false;
    const settle = (exitCode: number | undefined) => {
      if (settled) return;
      settled = true;
      disposables.forEach(d => d.dispose());
      resolve({ exitCode, output: buffered });
    };
    const disposables: vscode.Disposable[] = [];

    // Track the specific TerminalShellExecution we kicked off so other
    // executions in the same terminal don't resolve us prematurely.
    let ourExecution: vscode.TerminalShellExecution | undefined;

    disposables.push(
      vscode.window.onDidEndTerminalShellExecution(e => {
        if (e.execution === ourExecution) settle(e.exitCode);
      }),
      vscode.window.onDidCloseTerminal(t => {
        if (t === terminal) settle(t.exitStatus?.code);
      })
    );

    const run = () => {
      const si = terminal.shellIntegration;
      if (si) {
        ourExecution = si.executeCommand(command);
        // Best-effort: drain the execution's data stream so we can parse
        // post-run summaries (e.g. token usage). Stays an empty string if
        // the API is unavailable or the read fails.
        const exec = ourExecution;
        const reader = (exec as unknown as { read?: () => AsyncIterable<string> }).read;
        if (typeof reader === 'function') {
          (async () => {
            try {
              for await (const chunk of reader.call(exec)) {
                buffered += chunk;
                if (buffered.length > 200_000) {
                  buffered = buffered.slice(-200_000);
                }
              }
            } catch {
              // ignore — output capture is best-effort
            }
          })();
        }
      } else {
        terminal.sendText(command, true);
      }
    };

    if (terminal.shellIntegration) {
      run();
    } else {
      // Shell integration activates asynchronously. Wait briefly; if it never
      // arrives, fall back to plain sendText so the agent still runs.
      const integrationSub = vscode.window.onDidChangeTerminalShellIntegration(e => {
        if (e.terminal === terminal) {
          integrationSub.dispose();
          clearTimeout(timeout);
          run();
        }
      });
      disposables.push(integrationSub);
      const timeout = setTimeout(() => {
        integrationSub.dispose();
        run();
      }, 4000);
    }
  });

  return { terminal, done, getOutput: () => buffered };
}

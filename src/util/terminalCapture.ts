import * as vscode from 'vscode';

export interface SpawnedAgentTerminal {
  terminal: vscode.Terminal;
  /** Resolves when the terminal closes; exitCode may be undefined if user closed it. */
  done: Promise<{ exitCode: number | undefined }>;
}

/**
 * Open an integrated terminal, send a command, and resolve when the terminal closes.
 *
 * VS Code's terminal API does not expose stdout capture for shell-integration-free
 * terminals, so we don't try to tail output here — callers store a static prompt
 * snippet and update status based on exit code.
 */
export function spawnAgentTerminal(name: string, cwd: vscode.Uri, command: string): SpawnedAgentTerminal {
  const terminal = vscode.window.createTerminal({ name, cwd });
  terminal.show(true);
  terminal.sendText(command, true);

  const done = new Promise<{ exitCode: number | undefined }>(resolve => {
    const sub = vscode.window.onDidCloseTerminal(t => {
      if (t === terminal) {
        sub.dispose();
        resolve({ exitCode: t.exitStatus?.code });
      }
    });
  });

  return { terminal, done };
}

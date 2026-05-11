// Extension: build-vsix
//
// Runs .github/hooks/build-vsix.ps1 after every turn completes (the
// `session.idle` event), which is the equivalent of the "agentStop" hook
// originally requested. The hook handles version bumping and packaging
// the .vsix; this extension is just the trigger.
//
// Behavior:
//   - Fires on `session.idle`, never blocking the next user turn.
//   - Skips if a build is already in flight (no concurrent builds).
//   - Skips if the most recent run finished in the last 2 seconds, to
//     coalesce back-to-back idle events that some flows emit.
//   - Surfaces start / success / failure to the timeline via session.log.
//   - Hard-caps a single run at 10 minutes; stragglers are killed.
//
// IMPORTANT: never use console.log — stdout is reserved for JSON-RPC.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { joinSession } from "@github/copilot-sdk/extension";

const HOOK_REL_PATH = ".github/hooks/build-vsix.ps1";
const TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
const COALESCE_MS = 2_000;

let running = false;
let lastFinishedAt = 0;

const session = await joinSession({});

session.on("session.idle", () => {
    void runHook().catch((err) => {
        // Defensive: runHook already logs failures; this guards against
        // unexpected throws from the wrapper itself.
        void session.log(`build-vsix hook crashed: ${err?.message || err}`, {
            level: "error",
        });
    });
});

async function runHook() {
    if (running) {
        return;
    }
    if (Date.now() - lastFinishedAt < COALESCE_MS) {
        return;
    }

    const repoRoot = process.cwd();
    const hookPath = join(repoRoot, HOOK_REL_PATH);
    if (!existsSync(hookPath)) {
        await session.log(
            `build-vsix hook not found at ${HOOK_REL_PATH}; skipping.`,
            { level: "warning", ephemeral: true },
        );
        return;
    }

    running = true;
    await session.log("Running build-vsix hook…", { ephemeral: true });

    try {
        const result = await spawnHook(hookPath, repoRoot);
        if (result.code === 0) {
            await session.log("build-vsix hook completed successfully.", {
                ephemeral: true,
            });
        } else {
            const tail = tailLines(result.output, 20);
            await session.log(
                `build-vsix hook failed (exit ${result.code}). Last output:\n${tail}`,
                { level: "error" },
            );
        }
    } finally {
        lastFinishedAt = Date.now();
        running = false;
    }
}

function spawnHook(hookPath, cwd) {
    return new Promise((resolve) => {
        const child = spawn(
            "pwsh",
            [
                "-NoProfile",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
                hookPath,
            ],
            {
                cwd,
                windowsHide: true,
                stdio: ["ignore", "pipe", "pipe"],
            },
        );

        let output = "";
        child.stdout.on("data", (chunk) => {
            output += chunk.toString();
        });
        child.stderr.on("data", (chunk) => {
            output += chunk.toString();
        });

        const timer = setTimeout(() => {
            output += `\n[build-vsix] timed out after ${TIMEOUT_MS / 1000}s; killing.`;
            child.kill("SIGKILL");
        }, TIMEOUT_MS);

        child.on("error", (err) => {
            clearTimeout(timer);
            resolve({ code: -1, output: `${output}\nspawn error: ${err.message}` });
        });

        child.on("close", (code) => {
            clearTimeout(timer);
            resolve({ code: code ?? -1, output });
        });
    });
}

function tailLines(text, n) {
    const lines = text.split(/\r?\n/);
    return lines.slice(-n).join("\n").trim() || "(no output)";
}

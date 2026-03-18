import { readFileAsync, getFilePath, editFile, listFiles, WORKSPACE_DIR } from "./workspace.ts";
import { Ollama } from "ollama";

export const TOOLS: { [id: string]: any } = {
    read_file: {
        type: "function",
        function: {
            name: "read_file",
            description:
                "Read the contents of a file in the workspace. Only files in the workspace directory can be read.",
            parameters: {
                type: "object",
                properties: {
                    path: {
                        type: "string",
                        description: "Relative path to the file within the workspace (e.g. 'AGENTS.md').",
                    },
                },
                required: ["path"],
            },
        },
    },
    edit_file: {
        type: "function",
        function: {
            name: "edit_file",
            description:
                "Overwrite the contents of an existing file in the workspace. You cannot create new files or delete files — only edit files that already exist.",
            parameters: {
                type: "object",
                properties: {
                    path: {
                        type: "string",
                        description: "Relative path to the file within the workspace.",
                    },
                    content: {
                        type: "string",
                        description: "The new complete content to write to the file.",
                    },
                },
                required: ["path", "content"],
            },
        },
    },
    list_files: {
        type: "function",
        function: {
            name: "list_files",
            description: "List all files currently in the workspace directory.",
            parameters: {
                type: "object",
                properties: {},
                required: [],
            },
        },
    },
    send_file: {
        type: "function",
        function: {
            name: "send_file",
            description:
                "Send a file from the workspace as a Discord attachment. The file will be sent after the agent's response.",
            parameters: {
                type: "object",
                properties: {
                    path: {
                        type: "string",
                        description: "Relative path to the file within the workspace.",
                    },
                    caption: {
                        type: "string",
                        description: "Optional caption for the file.",
                    },
                },
                required: ["path"],
            },
        },
    },
    shell: {
        type: "function",
        function: {
            name: "shell",
            description:
                "Run a shell command. This is in a sandboxed environment with a bash-like shell. `~` is your workspace, and is the default working directory. You've got all the commands you'd expect, like `grep`, `cat`, `sed`, and so on. However, you don't have access to Python or other runtimes. Treat this as a way to interact with the workspace and files. You can use `grep -ri 'some text'` to search for text recursively from the working directory.",
            parameters: {
                type: "object",
                properties: {
                    description: {
                        type: "string",
                        description: "User-facing description of what you're doing. Like: \"Searching through memory files\", \"Writing to MEMORY.md\", and so on. Don't add an elipsis at the end. Keep this concise.",
                    },
                    shell_command: {
                        type: "string",
                        description: "The shell command to run.",
                    },
                },
                required: ["description", "shell_command"],
            },
        },
    }
} as const;

const CACHE_DIR = path.resolve(import.meta.dir, "../cache/embeddings");
const SIMILARITY_THRESHOLD = 0.65;

function cosineSimilarity(vecA: number[], vecB: number[]): number {
    const dotProduct = vecA.reduce((sum, a, i) => sum + a * vecB[i]!, 0);
    const magnitudeA = Math.sqrt(vecA.reduce((sum, a) => sum + a * a, 0));
    const magnitudeB = Math.sqrt(vecB.reduce((sum, b) => sum + b * b, 0));
    if (magnitudeA === 0 || magnitudeB === 0) return 0;
    return dotProduct / (magnitudeA * magnitudeB);
}

async function hashString(text: string): Promise<string> {
    const data = new TextEncoder().encode(text);
    const buf = await crypto.subtle.digest("SHA-256", data);
    return Array.from(new Uint8Array(buf))
        .map(b => b.toString(16).padStart(2, "0"))
        .join("");
}

interface LineCache {
    text: string;
    hash: string;
    embedding: number[];
}

interface FileCache {
    fileHash: string;
    lines: LineCache[];
}

async function getOllamaEmbedding(ollama: Ollama, model: string, text: string): Promise<number[]> {
    const response = await ollama.embed({ model, input: text });
    return response.embeddings[0]!;
}

async function getCachedFileEmbeddings(
    relPath: string,
    content: string,
    ollama: Ollama,
    embedModel: string,
): Promise<LineCache[]> {
    // Cache file path: flat, safe name derived from the relative path
    const safeName = relPath.replace(/[/\\]/g, "__");
    const cacheFile = path.join(CACHE_DIR, safeName + ".json");
    const fileHash = await hashString(content);

    let existing: FileCache | null = null;
    try {
        const raw = await readFile(cacheFile, "utf-8");
        existing = JSON.parse(raw) as FileCache;
    } catch {
        // not cached yet or unreadable
    }

    if (existing?.fileHash === fileHash) {
        return existing.lines;
    }

    // Build lookup of already-embedded lines by their hash to avoid re-embedding unchanged lines
    const existingByHash = new Map<string, number[]>();
    if (existing) {
        for (const l of existing.lines) {
            if (l.hash && l.embedding.length) {
                existingByHash.set(l.hash, l.embedding);
            }
        }
    }

    const rawLines = content.split("\n");
    const newLines: LineCache[] = [];

    for (const lineText of rawLines) {
        const trimmed = lineText.trim();
        if (!trimmed) {
            newLines.push({ text: lineText, hash: "", embedding: [] });
            continue;
        }
        const lineHash = await hashString(trimmed);
        const cached = existingByHash.get(lineHash);
        if (cached) {
            newLines.push({ text: lineText, hash: lineHash, embedding: cached });
        } else {
            const embedding = await getOllamaEmbedding(ollama, embedModel, trimmed);
            newLines.push({ text: lineText, hash: lineHash, embedding });
        }
    }

    const newCache: FileCache = { fileHash, lines: newLines };
    await mkdir(path.dirname(cacheFile), { recursive: true });
    await writeFile(cacheFile, JSON.stringify(newCache));
    return newLines;
}

async function semanticSearch(query: string, config: OpoclawConfig): Promise<string[]> {
    const ollamaBaseUrl = config.ollama?.base_url ?? "http://localhost:11434";
    const embedModel = "nomic-embed-text";
    const ollama = new Ollama({ host: ollamaBaseUrl });

    // Gather all workspace files
    const glob = new Bun.Glob("**/*");
    const files: string[] = [];
    for await (const f of glob.scan({ cwd: WORKSPACE_DIR, onlyFiles: true })) {
        files.push(f);
    }

    const queryEmbedding = await getOllamaEmbedding(ollama, embedModel, query);

    const results: { similarity: number; line: string; file: string }[] = [];

    for (const relPath of files) {
        let content: string;
        try {
            content = await readFile(path.join(WORKSPACE_DIR, relPath), "utf-8");
        } catch {
            continue;
        }
        const lines = await getCachedFileEmbeddings(relPath, content, ollama, embedModel);
        for (const l of lines) {
            if (!l.embedding.length) continue;
            const sim = cosineSimilarity(queryEmbedding, l.embedding);
            if (sim >= SIMILARITY_THRESHOLD) {
                results.push({ similarity: sim, line: l.text, file: relPath });
            }
        }
    }

    results.sort((a, b) => b.similarity - a.similarity);
    return results.map(r => `[${r.file}] ${r.line.trim()} (score: ${r.similarity.toFixed(3)})`);
}

// Track pending file sends (picked up by index.ts after tool execution)
export let pendingFileSend: { path: string; caption: string } | null = null;

export function clearPendingFileSend(): void {
    pendingFileSend = null;
}

import { WasmShell } from "wasm-shell";
const shell = new WasmShell();

import path from "path";
import { mkdir, readdir, readFile, writeFile, rm, stat as fsStat } from "fs/promises";
import { getSemanticSearchEnabled, type OpoclawConfig } from "./config.ts";
const toReal = (rel: string) => path.join(WORKSPACE_DIR, rel);

shell.mount("/home/", {
    async read(path) {
        return readFile(toReal(path));
    },
    async write(path, data) {
        const full = toReal(path);
        await mkdir(full.substring(0, full.lastIndexOf("/")), { recursive: true });
        await writeFile(full, data);
    },
    async list(path) {
        const entries = await readdir(toReal(path), { withFileTypes: true });
        return entries.map(e => e.name);
    },
    async stat(path) {
        const s = await fsStat(toReal(path));
        return { isFile: s.isFile(), isDir: s.isDirectory(), isDevice: false, size: s.size };
    },
    async remove(path) {
        await rm(toReal(path), { recursive: true, force: true });
    },
});

shell.setEnv("HOME", "/home");
shell.setCwd("/home");

let shellSetUp = false;

const dec = new TextDecoder();

export async function handleToolCall(
    name: string,
    args: Record<string, string>,
    config: OpoclawConfig,
): Promise<string> {
    console.log(`Handling tool call: ${name} with args ${JSON.stringify(args)}`);
    switch (name) {
        case "read_file": {
            if (!args.path) throw new Error("Missing 'path' argument for read_file.");
            const content = await readFileAsync(args.path);
            return content;
        }
        case "edit_file": {
            if (!args.path) throw new Error("Missing 'path' argument for edit_file.");
            if (args.content === undefined)
                throw new Error("Missing 'content' argument for edit_file.");
            await editFile(args.path, args.content);
            return `Successfully wrote ${args.content.length} characters to "${args.path}".`;
        }
        case "list_files": {
            const files = await listFiles();
            return files.length > 0
                ? files.map((f) => `• ${f}`).join("\n")
                : "(workspace is empty)";
        }
        case "send_file": {
            if (!args.path) throw new Error("Missing 'path' argument for send_file.");
            // Validate file exists
            getFilePath(args.path);
            // Queue file for sending after response
            pendingFileSend = { path: args.path, caption: args.caption || "" };
            return `File "${args.path}" queued for sending.`;
        }
        case "shell": {
            if (!shellSetUp) {
                shellSetUp = true;
                if (getSemanticSearchEnabled(config)) {
                    const enc = new TextEncoder();
                    shell.addProgram('semantic-search', async (ctx) => {
                        const query = ctx.args.slice(1).join(' ').trim();
                        if (!query || query === '--help') {
                            await ctx.writeStderr(enc.encode('Usage: semantic-search <query>\n'));
                            return 1;
                        }
                        const searchResults = await semanticSearch(query, config);
                        const out = searchResults.length > 0
                            ? searchResults.join('\n') + '\n'
                            : '(no results)\n';
                        await ctx.writeStdout(enc.encode(out));
                        return 0;
                    });
                }
            }
            if (!args.shell_command) throw new Error("Missing 'shell_command' argument for shell.");
            const result = await shell.exec(args.shell_command);
            let output = "";
            
            if (result.stdout) output += `stdout:\n\`\`\`${dec.decode(result.stdout).trim()}\`\`\`\n`;
            if (result.stderr) output += `stderr:\n\`\`\`${dec.decode(result.stderr).trim()}\`\`\`\n`;
            if (output.length === 0) output = "(no shell output)";
            if (result.code !== 0) output = `Command exited with code ${result.code}.\n` + output;
            const home = shell.getEnv("HOME") ?? "/home";
            const cwd = shell.getCwd();
            const display = cwd === home
                ? "~"
                : cwd.startsWith(home + "/")
                    ? "~" + cwd.slice(home.length)
                    : cwd;
            return output.trim() + `\n(Current directory: ${display})`;
        }
        default:
            throw new Error(`Unknown tool: ${name}`);
    }
}

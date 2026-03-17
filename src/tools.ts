import { readFileAsync, editFile, listFiles } from "./workspace.ts";

export const TOOL_DEFINITIONS = [
    {
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
    {
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
    {
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
] as const;

export async function handleToolCall(
    name: string,
    args: Record<string, string>
): Promise<string> {
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
        default:
            throw new Error(`Unknown tool: ${name}`);
    }
}

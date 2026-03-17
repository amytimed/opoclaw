import { TOOL_DEFINITIONS, handleToolCall } from "./tools.ts";

interface Message {
    role: "system" | "user" | "assistant" | "tool";
    content: string | null;
    tool_calls?: ToolCall[];
    tool_call_id?: string;
    name?: string;
}

interface ToolCall {
    id: string;
    type: "function";
    function: {
        name: string;
        arguments: string;
    };
}

interface Config {
    openrouterKey: string;
    openrouterModel: string;
}

async function streamCompletion(
    messages: Message[],
    config: Config,
    onFirstToken: () => void
): Promise<{ text: string | null; toolCalls: ToolCall[] }> {
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
            Authorization: `Bearer ${config.openrouterKey}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify({
            model: config.openrouterModel,
            messages,
            tools: TOOL_DEFINITIONS,
            tool_choice: "auto",
            stream: true,
        }),
    });

    if (!response.ok) {
        const err = await response.text();
        throw new Error(`OpenRouter error ${response.status}: ${err}`);
    }

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();

    let textBuffer = "";
    let firstToken = false;

    // Accumulate tool call deltas indexed by index
    const toolCallMap: Record<
        number,
        { id: string; name: string; arguments: string }
    > = {};

    let finishReason: string | null = null;

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        const lines = chunk.split("\n");

        for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            const data = line.slice(6).trim();
            if (data === "[DONE]") { finishReason = finishReason ?? "stop"; continue; }

            let parsed: any;
            try { parsed = JSON.parse(data); } catch { continue; }

            const choice = parsed.choices?.[0];
            if (!choice) continue;

            finishReason = choice.finish_reason ?? finishReason;

            const delta = choice.delta;
            if (!delta) continue;

            // Reasoning tokens (thinking models like Qwen)
            if ((delta as any).reasoning && !firstToken) {
                firstToken = true;
                onFirstToken();
            }

            // Text content
            if (delta.content) {
                if (!firstToken) {
                    firstToken = true;
                    onFirstToken();
                }
                textBuffer += delta.content;
            }

            // Tool call deltas
            if (delta.tool_calls) {
                for (const tc of delta.tool_calls) {
                    const idx: number = tc.index ?? 0;
                    if (!toolCallMap[idx]) {
                        toolCallMap[idx] = { id: tc.id ?? "", name: "", arguments: "" };
                    }
                    if (tc.id) toolCallMap[idx].id = tc.id;
                    if (tc.function?.name) toolCallMap[idx].name += tc.function.name;
                    if (tc.function?.arguments) toolCallMap[idx].arguments += tc.function.arguments;
                }

                // Fire onFirstToken for tool calls too (spinner should start)
                if (!firstToken) {
                    firstToken = true;
                    onFirstToken();
                }
            }
        }
    }

    const toolCalls: ToolCall[] = Object.entries(toolCallMap).map(([, tc]) => ({
        id: tc.id,
        type: "function",
        function: { name: tc.name, arguments: tc.arguments },
    }));

    return { text: textBuffer || null, toolCalls };
}

export async function runAgent(
    history: Message[],
    systemPrompt: string,
    config: Config,
    onFirstToken: () => void,
    onProgress?: (text: string) => void
): Promise<string> {
    const messages: Message[] = [
        { role: "system", content: systemPrompt },
        ...history,
    ];

    let firstTokenFired = false;
    const wrappedOnFirstToken = () => {
        if (!firstTokenFired) {
            firstTokenFired = true;
            onFirstToken();
        }
    };

    for (let iteration = 0; iteration < 20; iteration++) {
        const { text, toolCalls } = await streamCompletion(
            messages,
            config,
            wrappedOnFirstToken
        );

        if (toolCalls.length > 0) {
            messages.push({
                role: "assistant",
                content: text,
                tool_calls: toolCalls,
            });

            for (const tc of toolCalls) {
                let result: string;
                try {
                    const args = JSON.parse(tc.function.arguments);
                    result = await handleToolCall(tc.function.name, args);
                } catch (e: any) {
                    result = `Error: ${e.message}`;
                }
                messages.push({
                    role: "tool",
                    tool_call_id: tc.id,
                    name: tc.function.name,
                    content: result,
                });
            }

            continue;
        }

        return text ?? "(no response)";
    }

    return "(agent loop limit reached)";
}

export type { Message, Config };

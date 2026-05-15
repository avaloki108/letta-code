import { APICallError, generateText, type LanguageModel, streamText } from "ai";
import { createAISDKModelFactoryFromAgent } from "../dev/AISDKModelFactory";
import { buildAISDKProviderOptions } from "../dev/AISDKStreamAdapter";
import { isContextWindowOverflowError } from "../dev/contextWindowOverflow";
import type { LocalMessage } from "./LocalMessage";
import type { LocalAgentRecord } from "./LocalStore";

const ALL_WORD_LIMIT = 500;
const SLIDING_WORD_LIMIT = 300;
const SUMMARY_TRUNCATION_SUFFIX = "... [summary truncated to fit]";
const TOOL_RETURN_TRUNCATION_CHARS = 5000;
const TRANSCRIPT_FALLBACK_MAX_CHARS = 120000;
const TRANSCRIPT_FALLBACK_MAX_CHAR_STEPS = [
  TRANSCRIPT_FALLBACK_MAX_CHARS,
  90_000,
  60_000,
  40_000,
  25_000,
  15_000,
  10_000,
  6_000,
  4_000,
  2_000,
] as const;
export const LOCAL_DEFAULT_COMPACTION_MODE = "sliding_window";
export const LOCAL_DEFAULT_SLIDING_WINDOW_PERCENTAGE = 0.3;

export type LocalCompactionMode = "all" | "sliding_window";

export class LocalSlidingWindowCompactionPlanningError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LocalSlidingWindowCompactionPlanningError";
  }
}

export function isLocalSlidingWindowCompactionPlanningError(
  error: unknown,
): error is LocalSlidingWindowCompactionPlanningError {
  return error instanceof LocalSlidingWindowCompactionPlanningError;
}

export const LOCAL_ALL_COMPACTION_PROMPT = `Your task is to create a detailed summary of the conversation so far, paying close attention to the user's explicit requests and your previous actions.
This summary should be thorough in capturing technical details, code patterns, and architectural decisions that would be essential for continuing development work without losing context. Your summary should include the following sections:

1.**High level goals**: What is the high level goal and ongoing task? Capture the user's explicit requests and intent in detail. If there is an existing summary in the transcript, make sure to take it into consideration to continue tracking the higher level goals and long-term progress.

2. **What happened**: The conversations, tasks, and exchanges that took place. What did the user ask for? What did you do? How did things progress? If there is a previous summary being evicted, please extract a concise version of the critical info from it.

3. **Important details**: Enumerate specific files and code sections examined, modified, or created, as well as important plan files, GitHub issues/PR links, and Linear ticket IDs. For each item, include why it matters and any relevant names, data, configs, or facts discussed.
   - **Preserve identifiers verbatim** (plan filename/path, exact URL, issue/PR number, ticket ID); do not paraphrase or truncate.
   - **Preserve referenced identifiers unless explicitly resolved**: Keep exact URLs/IDs from the conversation unless there is clear evidence they are no longer relevant.
   - Do not omit details likely to be referenced later.

4. **Errors and fixes**: List all errors that you ran into, and how you fixed them. Pay special attention to specific user feedback that you received and record verbatim if useful.

5. **Current state**:Describe in detail precisely what is currently being worked on, paying special attention to the most recent messages from both user and assistant. Include file names and code snippets where applicable.

6.**Optional Next Step**: List the next step that you will take that is related to the most recent work you were doing. IMPORTANT: ensure that this step is DIRECTLY in line with the user's most recent explicit requests and the most current task. If your last task was concluded, then only list next steps if they are explicitly in line with the users request. If there is a next step, include direct quotes from the most recent conversation showing exactly what task you were working on and where you left off.

7. **Lookup hints**: For any detailed content (long lists, extensive data, specific conversations) that couldn't fit in the summary, note the topic and key terms that could be used to find it in message history later.

Write in first person as a factual record of what occurred. Be concise but thorough - the goal is to preserve enough context that the recent messages make sense and important information isn't lost to prevent duplicate work or repeated mistakes.

Keep your summary under ${ALL_WORD_LIMIT} words. Only output the summary.`;

export const LOCAL_SLIDING_WINDOW_COMPACTION_PROMPT = `The following messages are being evicted from the BEGINNING of your context window. Write a detailed summary that captures what happened in these messages to appear BEFORE the remaining recent messages in context, providing background for what comes after. Include the following sections:

1.**High level goals**: What is the high level goal and ongoing task? Capture the user's explicit requests and intent in detail. If there is an existing summary in the transcript, make sure to take it into consideration to continue tracking the higher level goals and long-term progress.

2. **What happened**: The conversations, tasks, and exchanges that took place. What did the user ask for? What did you do? How did things progress? If there is a previous summary being evicted, please extract a concise version of the critical info from it.

3. **Important details**: Enumerate specific files and code sections examined, modified, or created, as well as important plan files, GitHub issues/PR links, and Linear ticket IDs. For each item, include why it matters and any relevant names, data, configs, or facts discussed.
   - **Preserve identifiers verbatim** (plan filename/path, exact URL, issue/PR number, ticket ID); do not paraphrase or truncate.
   - **Preserve referenced identifiers unless explicitly resolved**: Keep exact URLs/IDs from the conversation unless there is clear evidence they are no longer relevant.
   - Do not omit details likely to be referenced later.

4. **Errors and fixes**: List all errors that you ran into, and how you fixed them. Pay special attention to specific user feedback that you received and record verbatim if useful.

5. **Lookup hints**: For any detailed content (long lists, extensive data, specific conversations) that couldn't fit in the summary, note the topic and key terms that could be used to find it in message history later.

Write in first person as a factual record of what occurred. Be thorough and detailed - the goal is to preserve enough context that the recent messages make sense and important information isn't lost to prevent duplicate work or repeated mistakes.

Keep your summary under ${SLIDING_WORD_LIMIT} words. Only output the summary.`;

export interface LocalCompactionStats {
  trigger?: string;
  context_tokens_before?: number;
  context_tokens_after?: number;
  context_window?: number;
  messages_count_before?: number;
  messages_count_after?: number;
}

function isChatGPTOAuthModel(agent: LocalAgentRecord): boolean {
  return (
    agent.model.startsWith("chatgpt-plus-pro/") ||
    agent.model_settings.provider_type === "chatgpt_oauth"
  );
}

export type LocalGenerateTextFunction = (options: {
  model: LanguageModel;
  system?: string;
  prompt?: string;
  providerOptions?: Parameters<typeof generateText>[0]["providerOptions"];
  maxRetries: number;
  abortSignal?: AbortSignal;
}) => ReturnType<typeof generateText>;

export interface LocalAllCompactionInput {
  agent: LocalAgentRecord;
  messages: LocalMessage[];
  createModel?: () => LanguageModel;
  generateText?: LocalGenerateTextFunction;
  prompt?: string | null;
  clipChars?: number | null;
  abortSignal?: AbortSignal;
  localProviderAuthStorageDir?: string;
  morph?: LocalMorphCompactionOptions;
}

export interface LocalMorphCompactionOptions {
  apiKey?: string;
  apiUrl?: string;
  compressionRatio?: number;
  preserveRecent?: number;
  includeMarkers?: boolean;
  includeLineRanges?: boolean;
  query?: string;
  model?: string;
}

interface MorphCompactMessage {
  role: string;
  content: string;
}

interface MorphCompactResponse {
  output?: unknown;
  messages?: Array<{ content?: unknown }>;
}

export interface LocalSlidingWindowCompactionPlan {
  messagesToSummarize: LocalMessage[];
  messagesToKeep: LocalMessage[];
  cutoffIndex: number;
}

export interface LocalAllCompactionPlan {
  messagesToSummarize: LocalMessage[];
  messagesToKeep: LocalMessage[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringifyUnknown(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function truncateToolReturn(content: string, limit?: number): string {
  if (limit === undefined || content.length <= limit) return content;
  const hardCut = content.slice(0, limit);
  const newlineCut = hardCut.lastIndexOf("\n");
  const cut = newlineCut > Math.floor(limit * 0.65) ? newlineCut : limit;
  return `${content.slice(0, cut)}... [truncated ${content.length - cut} chars]`;
}

function stripCompactionOnlyInjections(text: string): string {
  return text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, "")
    .replace(/<memory_metadata>[\s\S]*?<\/memory_metadata>/gi, "")
    .replace(/<available_skills>[\s\S]*?<\/available_skills>/gi, "")
    .replace(/<task-notification>[\s\S]*?<\/task-notification>/gi, (block) => {
      const summary = block
        .match(/<summary>([\s\S]*?)<\/summary>/i)?.[1]
        ?.trim();
      const taskId = block
        .match(/<task-id>([\s\S]*?)<\/task-id>/i)?.[1]
        ?.trim();
      return summary
        ? `[task-notification ${taskId ?? "unknown"}: ${summary}]`
        : "";
    })
    .trim();
}

function hasLocalToolPart(message: LocalMessage): boolean {
  return message.parts.some(
    (part) =>
      isRecord(part) &&
      typeof part.type === "string" &&
      part.type.startsWith("tool-"),
  );
}

function extractTailAssistantText(
  messages: LocalMessage[],
): string | undefined {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (!message || message.role !== "assistant") continue;
    const text = textFromContentParts(message.parts)?.trim();
    if (!text) continue;
    const paragraphs = text
      .split(/\n{2,}/)
      .map((part) => part.trim())
      .filter(Boolean);
    const tail = paragraphs.at(-1) ?? text;
    return tail.length > 1200 ? `${tail.slice(-1200)}` : tail;
  }
  return undefined;
}

function appendTailAnchorToSummary(
  summary: string,
  messages: LocalMessage[],
): string {
  const tail = extractTailAssistantText(messages);
  if (!tail || summary.includes(tail)) return summary;
  return `${summary}\n\nRecent assistant tail anchor preserved verbatim:\n${tail}`;
}

function middleTruncateText(
  text: string,
  budgetChars: number,
  headFrac = 0.3,
  tailFrac = 0.3,
): string {
  if (budgetChars <= 0 || text.length <= budgetChars) return text;
  const headLength = Math.max(0, Math.floor(budgetChars * headFrac));
  let tailLength = Math.max(0, Math.floor(budgetChars * tailFrac));
  if (headLength + tailLength > budgetChars) {
    tailLength = Math.max(0, budgetChars - headLength);
  }

  const head = text.slice(0, headLength);
  const tail = tailLength > 0 ? text.slice(-tailLength) : "";
  const dropped = Math.max(0, text.length - (head.length + tail.length));
  const marker = `\n[TRUNCATED: dropped ${dropped} middle chars due to context budget]\n`;
  return `${head}${marker}${tail}`;
}

type SummaryOpenAIMessage = {
  role: "assistant" | "developer" | "system" | "tool" | "user";
  content?: string | null | Array<{ text?: string } | string>;
  tool_calls?: Array<{
    function?: {
      name?: string;
      arguments?: string;
    };
  }>;
};

function textFromContentParts(
  parts: LocalMessage["parts"],
): string | undefined {
  const textParts: string[] = [];
  let imageCount = 0;
  for (const part of parts) {
    if (!isRecord(part)) continue;
    if (
      (part.type === "text" || part.type === "reasoning") &&
      typeof part.text === "string"
    ) {
      textParts.push(part.text);
      continue;
    }
    if (part.type === "file" && typeof part.mediaType === "string") {
      if (part.mediaType.startsWith("image/")) imageCount += 1;
      continue;
    }
    if (part.type === "source-url" || part.type === "source-document") {
      textParts.push(stringifyUnknown(part));
    }
  }

  let textContent = textParts.join("\n\n");
  if (imageCount > 0) {
    const placeholder =
      imageCount === 1 ? "[Image omitted]" : `[${imageCount} images omitted]`;
    textContent = `${textContent}${textContent ? " " : ""}${placeholder}`;
  }
  return textContent || undefined;
}

function toolNameFromPart(part: Record<string, unknown>): string {
  return typeof part.type === "string" && part.type.startsWith("tool-")
    ? part.type.slice("tool-".length)
    : "?";
}

function localToolCallArguments(input: unknown): string {
  return typeof input === "string" ? input : stringifyUnknown(input ?? {});
}

function toolReturnToText(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return stringifyUnknown(value);

  const textParts: string[] = [];
  let imageCount = 0;
  for (const item of value) {
    if (
      isRecord(item) &&
      item.type === "text" &&
      typeof item.text === "string"
    ) {
      textParts.push(item.text);
      continue;
    }
    if (isRecord(item) && item.type === "image") {
      imageCount += 1;
    }
  }
  let result = textParts.join("\n");
  if (imageCount > 0) {
    const placeholder =
      imageCount === 1 ? "[Image omitted]" : `[${imageCount} images omitted]`;
    result = `${result}${result ? " " : ""}${placeholder}`;
  }
  return result || undefined;
}

function isLocalToolOutputState(state: unknown): boolean {
  return (
    state === "output-available" ||
    state === "output-error" ||
    state === "output-denied"
  );
}

function localMessagesToSummaryOpenAIDicts(
  messages: LocalMessage[],
  options: { toolReturnTruncationChars?: number } = {},
): SummaryOpenAIMessage[] {
  const result: SummaryOpenAIMessage[] = [];
  for (const message of messages) {
    if (message.role === "system") continue;

    const compactionSummary = message.metadata?.compaction?.summary;
    if (typeof compactionSummary === "string") {
      result.push({ role: "user", content: compactionSummary });
      continue;
    }

    const toolParts: Record<string, unknown>[] = [];
    for (const part of message.parts) {
      if (
        isRecord(part) &&
        typeof part.type === "string" &&
        part.type.startsWith("tool-")
      ) {
        toolParts.push(part);
      }
    }

    if (message.role === "assistant") {
      const content = textFromContentParts(message.parts) ?? null;
      if (content !== null || toolParts.length > 0) {
        result.push({
          role: "assistant",
          content,
          ...(toolParts.length > 0
            ? {
                tool_calls: toolParts.map((part) => ({
                  function: {
                    name: toolNameFromPart(part),
                    arguments: localToolCallArguments(part.input),
                  },
                })),
              }
            : {}),
        });
      }

      for (const part of toolParts) {
        if (!isLocalToolOutputState(part.state)) continue;
        const returnText = toolReturnToText(part.output ?? part.errorText);
        result.push({
          role: "tool",
          content: returnText
            ? truncateToolReturn(returnText, options.toolReturnTruncationChars)
            : null,
        });
      }
      continue;
    }

    const content = textFromContentParts(message.parts);
    if (content !== undefined) {
      result.push({
        role: message.role === "user" ? "user" : "developer",
        content,
      });
    }
  }
  return result;
}

function simpleFormatter(messages: SummaryOpenAIMessage[]): string {
  const lines: string[] = [];
  for (const message of messages) {
    try {
      const role = message.role ?? "?";
      let content: unknown = message.content;
      if (Array.isArray(content)) {
        content = content
          .map((block) =>
            isRecord(block) && typeof block.text === "string"
              ? block.text
              : String(block),
          )
          .join(" ");
      }
      let text =
        typeof content === "string"
          ? stripCompactionOnlyInjections(content)
          : "";
      if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
        const callParts = message.tool_calls.map((toolCall) => {
          const fn = toolCall.function ?? {};
          return `${fn.name ?? "?"}(${fn.arguments ?? ""})`;
        });
        text = `${text}${text ? " " : ""}-> ${callParts.join(", ")}`;
      }
      if (text) lines.push(`[${role}] ${text}`);
    } catch {
      lines.push(JSON.stringify(message));
    }
  }

  return ` \n${lines.join("\n")}\n \n. Generate the summary.`;
}

function compactMessageRole(
  role: SummaryOpenAIMessage["role"],
): "assistant" | "system" | "tool" | "user" {
  if (role === "assistant" || role === "system" || role === "tool") {
    return role;
  }
  return "user";
}

function morphMessagesFromLocalMessages(
  messages: LocalMessage[],
): MorphCompactMessage[] {
  return localMessagesToSummaryOpenAIDicts(messages, {
    toolReturnTruncationChars: TOOL_RETURN_TRUNCATION_CHARS,
  })
    .map((message) => {
      const formatted = simpleFormatter([message])
        .replace(/^ \n/, "")
        .replace(/\n \n\. Generate the summary\.$/, "")
        .trim();
      return {
        role: compactMessageRole(message.role),
        content: formatted,
      };
    })
    .filter((message) => message.content.length > 0);
}

function latestUserText(messages: LocalMessage[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (!message) continue;
    if (message.role !== "user") continue;
    const text = textFromContentParts(message.parts)?.trim();
    if (text) return text;
  }
  return undefined;
}

function boundedNumber(
  value: number | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function envNumber(name: string): number | undefined {
  const value = process.env[name]?.trim();
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function envBoolean(name: string): boolean | undefined {
  const value = process.env[name]?.trim().toLowerCase();
  if (!value) return undefined;
  if (["1", "true", "yes", "on"].includes(value)) return true;
  if (["0", "false", "no", "off"].includes(value)) return false;
  return undefined;
}

export function shouldUseMorphCompaction(settingsProvider?: unknown): boolean {
  if (settingsProvider === "morph") return true;
  const provider = process.env.LETTA_COMPACTION_PROVIDER?.trim().toLowerCase();
  return provider === "morph" || process.env.LETTA_USE_MORPH_COMPACTION === "1";
}

export async function compactLocalMessagesWithMorph(
  input: LocalAllCompactionInput,
  defaultPrompt: string,
): Promise<string> {
  if (input.messages.length === 0) return "No prior conversation messages.";
  const morph = input.morph ?? {};
  const apiKey = morph.apiKey ?? process.env.MORPH_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("Morph compaction requested but MORPH_API_KEY is not set.");
  }

  const apiUrl =
    morph.apiUrl ??
    process.env.MORPH_API_URL?.trim() ??
    "https://api.morphllm.com/v1/compact";
  const compressionRatio = boundedNumber(
    morph.compressionRatio ?? envNumber("LETTA_MORPH_COMPACTION_RATIO"),
    0.5,
    0.05,
    1,
  );
  const preserveRecent = Math.max(
    0,
    Math.floor(
      morph.preserveRecent ?? envNumber("LETTA_MORPH_PRESERVE_RECENT") ?? 3,
    ),
  );
  const includeMarkers =
    morph.includeMarkers ?? envBoolean("LETTA_MORPH_INCLUDE_MARKERS") ?? true;
  const includeLineRanges =
    morph.includeLineRanges ??
    envBoolean("LETTA_MORPH_INCLUDE_LINE_RANGES") ??
    false;

  const response = await fetch(apiUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messages: morphMessagesFromLocalMessages(input.messages),
      query:
        morph.query ??
        process.env.LETTA_MORPH_COMPACTION_QUERY?.trim() ??
        latestUserText(input.messages) ??
        defaultPrompt,
      compression_ratio: compressionRatio,
      preserve_recent: preserveRecent,
      include_markers: includeMarkers,
      include_line_ranges: includeLineRanges,
      model: morph.model ?? "morph-compactor",
    }),
    signal: input.abortSignal,
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `Morph compaction failed (${response.status} ${response.statusText})${
        body ? `: ${body}` : ""
      }`,
    );
  }

  const data = (await response.json()) as MorphCompactResponse;
  const output = typeof data.output === "string" ? data.output : undefined;
  const messageOutput = Array.isArray(data.messages)
    ? data.messages
        .map((message) =>
          typeof message.content === "string" ? message.content : "",
        )
        .filter(Boolean)
        .join("\n")
    : undefined;
  let summary = appendTailAnchorToSummary(
    (output ?? messageOutput ?? "").trim(),
    input.messages,
  );
  if (!summary) {
    throw new Error("Morph compaction did not return output.");
  }

  const clipChars = input.clipChars === undefined ? 50000 : input.clipChars;
  if (clipChars !== null && summary.length > clipChars) {
    summary = `${summary.slice(0, clipChars)}${SUMMARY_TRUNCATION_SUFFIX}`;
  }
  return summary;
}

export function formatLocalMessagesForSummary(
  messages: LocalMessage[],
  options: { truncationChars?: number; maxChars?: number } = {},
): string {
  const transcript = simpleFormatter(
    localMessagesToSummaryOpenAIDicts(messages, {
      toolReturnTruncationChars: options.truncationChars,
    }),
  );
  return options.maxChars
    ? middleTruncateText(transcript, options.maxChars)
    : transcript;
}

async function runGenerateText(
  input: LocalAllCompactionInput,
  transcript: string,
  defaultPrompt: string,
): Promise<{ text: string }> {
  const systemPrompt = input.prompt ?? defaultPrompt;
  const system =
    isChatGPTOAuthModel(input.agent) === true ? undefined : systemPrompt;
  const run = input.generateText ?? generateText;
  const model =
    input.createModel?.() ??
    createAISDKModelFactoryFromAgent(
      input.agent.model,
      input.agent.model_settings,
      { localProviderAuthStorageDir: input.localProviderAuthStorageDir },
    )();
  const providerOptions = buildAISDKProviderOptions(
    input.agent.model,
    input.agent.model_settings,
    { systemPrompt },
  );
  try {
    const result = await run({
      model,
      system,
      prompt: transcript,
      providerOptions,
      maxRetries: 0,
      abortSignal: input.abortSignal,
    });
    return { text: result.text };
  } catch (error) {
    const detail = [
      error instanceof Error ? error.message : "",
      APICallError.isInstance(error) ? String(error.responseBody ?? "") : "",
    ]
      .join("\n")
      .toLowerCase();
    if (!detail.includes("stream must be set to true")) {
      throw error;
    }

    let text = "";
    const result = streamText({
      model,
      system,
      prompt: transcript,
      providerOptions,
      maxRetries: 0,
      abortSignal: input.abortSignal,
      // Compaction handles stream error parts directly below.
      onError: () => {},
    });
    for await (const part of result.fullStream) {
      if (part.type === "text-delta") {
        text += part.text;
        continue;
      }
      if (part.type === "error") {
        throw part.error;
      }
    }
    return { text };
  }
}

async function summarizeLocalMessagesWithPrompt(
  input: LocalAllCompactionInput,
  defaultPrompt: string,
): Promise<string> {
  if (input.messages.length === 0) return "No prior conversation messages.";
  const primaryTranscript = formatLocalMessagesForSummary(input.messages);
  let result: { text: string } | undefined;
  try {
    result = await runGenerateText(input, primaryTranscript, defaultPrompt);
  } catch (error) {
    if (!isContextWindowOverflowError(error)) throw error;
    let overflowError: unknown = error;
    let previousTranscript: string | undefined;
    for (const maxChars of TRANSCRIPT_FALLBACK_MAX_CHAR_STEPS) {
      const fallbackTranscript = formatLocalMessagesForSummary(input.messages, {
        truncationChars: TOOL_RETURN_TRUNCATION_CHARS,
        maxChars,
      });
      if (fallbackTranscript === previousTranscript) continue;
      previousTranscript = fallbackTranscript;
      try {
        result = await runGenerateText(
          input,
          fallbackTranscript,
          defaultPrompt,
        );
        break;
      } catch (fallbackError) {
        if (!isContextWindowOverflowError(fallbackError)) throw fallbackError;
        overflowError = fallbackError;
      }
    }
    if (!result) throw overflowError;
  }

  if (!result) {
    throw new Error("Compaction summarizer did not return a result.");
  }
  let summary = appendTailAnchorToSummary(result.text.trim(), input.messages);
  const clipChars = input.clipChars === undefined ? 50000 : input.clipChars;
  if (clipChars !== null && summary.length > clipChars) {
    summary = `${summary.slice(0, clipChars)}${SUMMARY_TRUNCATION_SUFFIX}`;
  }
  return summary;
}

export async function summarizeLocalMessagesAll(
  input: LocalAllCompactionInput,
): Promise<string> {
  if (input.morph) {
    return compactLocalMessagesWithMorph(input, LOCAL_ALL_COMPACTION_PROMPT);
  }
  return summarizeLocalMessagesWithPrompt(input, LOCAL_ALL_COMPACTION_PROMPT);
}

function isSettledLocalToolState(state: unknown): boolean {
  return (
    state === "output-available" ||
    state === "output-error" ||
    state === "output-denied"
  );
}

function hasPendingLocalToolPart(message: LocalMessage): boolean {
  return message.parts.some((part) => {
    if (!isRecord(part)) return false;
    const partRecord: Record<string, unknown> = part;
    return (
      typeof partRecord.type === "string" &&
      partRecord.type.startsWith("tool-") &&
      !isSettledLocalToolState(partRecord.state)
    );
  });
}

function normalizedSlidingWindowPercentage(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return LOCAL_DEFAULT_SLIDING_WINDOW_PERCENTAGE;
  }
  if (value <= 0) return 0.1;
  if (value > 1) return 1;
  return value;
}

function isValidSlidingWindowCutoff(
  messages: LocalMessage[],
  index: number,
  maximumCutoffIndex: number,
): boolean {
  const message = messages[index];
  return (
    message?.role === "assistant" && index > 0 && index < maximumCutoffIndex
  );
}

export function planLocalSlidingWindowCompaction(
  messages: LocalMessage[],
  options: { slidingWindowPercentage?: number; contextWindow?: number } = {},
): LocalSlidingWindowCompactionPlan {
  if (messages.length < 4) {
    throw new LocalSlidingWindowCompactionPlanningError(
      "Not enough messages for sliding window compaction.",
    );
  }

  const percentage = normalizedSlidingWindowPercentage(
    options.slidingWindowPercentage,
  );
  const lastMessage = messages.at(-1);
  const maximumCutoffIndex =
    lastMessage && hasPendingLocalToolPart(lastMessage)
      ? messages.length - 2
      : messages.length - 1;
  const goalTokens =
    typeof options.contextWindow === "number" &&
    Number.isFinite(options.contextWindow)
      ? (1 - percentage) * options.contextWindow
      : undefined;
  const minimumCutoffIndex = Math.max(
    1,
    Math.round(percentage * messages.length),
  );
  const allValidCutoffIndices = messages
    .map((message, index) => ({ message, index }))
    .filter(({ message, index }) => {
      if (!isValidSlidingWindowCutoff(messages, index, maximumCutoffIndex)) {
        return false;
      }
      const previous = messages[index - 1];
      // Keep tool-bearing assistant messages intact with adjacent context when possible.
      return !(hasLocalToolPart(message) && previous?.role === "assistant");
    })
    .map(({ index }) => index);
  const validCutoffIndices =
    allValidCutoffIndices.filter((index) => index >= minimumCutoffIndex)
      .length > 0
      ? allValidCutoffIndices.filter((index) => index >= minimumCutoffIndex)
      : allValidCutoffIndices;

  let cutoffIndex: number | undefined;
  if (goalTokens === undefined) {
    cutoffIndex = validCutoffIndices[0];
  } else {
    let low = 0;
    let high = validCutoffIndices.length - 1;
    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      const candidate = validCutoffIndices[mid];
      if (candidate === undefined) break;
      const approxTokenCount = estimateLocalMessageTokens(
        messages.slice(candidate),
      );
      if (approxTokenCount <= goalTokens) {
        cutoffIndex = candidate;
        high = mid - 1;
      } else {
        low = mid + 1;
      }
    }
  }

  if (cutoffIndex === undefined) {
    throw new LocalSlidingWindowCompactionPlanningError(
      "No assistant message found for sliding window compaction.",
    );
  }

  if (cutoffIndex >= maximumCutoffIndex) {
    throw new LocalSlidingWindowCompactionPlanningError(
      `Assistant message index ${cutoffIndex} is at the end of the message buffer, skipping compaction.`,
    );
  }

  return {
    messagesToSummarize: messages.slice(0, cutoffIndex),
    messagesToKeep: messages.slice(cutoffIndex),
    cutoffIndex,
  };
}

export function planLocalAllCompaction(
  messages: LocalMessage[],
): LocalAllCompactionPlan {
  const lastMessage = messages.at(-1);
  if (lastMessage && hasPendingLocalToolPart(lastMessage)) {
    return {
      messagesToSummarize: messages.slice(0, -1),
      messagesToKeep: [lastMessage],
    };
  }

  return {
    messagesToSummarize: messages,
    messagesToKeep: [],
  };
}

export async function summarizeLocalMessagesSlidingWindow(
  input: LocalAllCompactionInput,
): Promise<string> {
  if (input.morph) {
    return compactLocalMessagesWithMorph(
      input,
      LOCAL_SLIDING_WINDOW_COMPACTION_PROMPT,
    );
  }
  return summarizeLocalMessagesWithPrompt(
    input,
    LOCAL_SLIDING_WINDOW_COMPACTION_PROMPT,
  );
}

export function estimateLocalMessageTokens(messages: LocalMessage[]): number {
  const chars = messages.reduce(
    (total, message) => total + JSON.stringify(message).length,
    0,
  );
  return Math.ceil(chars / 4);
}

export function packageLocalSummaryMessage(
  summary: string,
  stats?: LocalCompactionStats,
  mode?: LocalCompactionMode,
): string {
  let message: string;
  if (mode?.includes("sliding_window")) {
    if (
      stats?.messages_count_before !== undefined &&
      stats.messages_count_after !== undefined
    ) {
      const numEvicted =
        stats.messages_count_before - stats.messages_count_after;
      message = `Note: ${numEvicted} messages from the beginning of the conversation have been hidden from view due to memory constraints.\nThe following is a summary of the previous messages:\n ${summary}`;
    } else {
      message = `Note: prior messages from the beginning of the conversation have been hidden from view due to conversation memory constraints.\nThe following is a summary of the previous messages:\n ${summary}`;
    }
  } else {
    message = `Note: prior messages have been hidden from view due to conversation memory constraints.\nThe following is a summary of the previous messages:\n ${summary}`;
  }
  return JSON.stringify({
    type: "system_alert",
    message,
    time: new Date().toISOString(),
    ...(stats ? { compaction_stats: stats } : {}),
  });
}

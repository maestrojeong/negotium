export const ACTIVE_TASK_TEMPLATE = `You are compressing a long agent conversation so the main agent can continue
without losing context. Produce a single concise summary using EXACTLY these
section headers, in this order:

## Active Task
One sentence: what is the agent currently working on?

## Goal
One or two sentences: the user's overall objective in this session.

## Constraints
Bulleted list of durable requirements, user preferences, technical limits, or
process rules that should continue to govern the work. Skip if none.

## Key Decisions
Bulleted list of decisions already made that should not be reopened unless the
user asks. Include the rationale when it is short and important. Skip if none.

## Pending
Bulleted list of unresolved items, decisions to make, or work explicitly
deferred. Use "(blocked: <reason>)" when applicable.

## Next Steps
Bulleted list of the concrete next actions the main agent should take after
compaction, in likely execution order. Skip if none.

## Files
Bulleted list of \`absolute/paths\` touched or referenced (read, written,
inspected). Skip if none.

## Recent context
3-5 bullets capturing the most recent tool calls + their salient outputs.
Prefer specifics (paths, line numbers, exit codes, key values) over generic
recaps. Skip details that have no bearing on the next step.

RULES:
- Output ONLY the eight sections above, with no preamble or postscript.
- Do NOT echo the user's words verbatim - paraphrase tightly.
- Do NOT invent file paths or facts not present in the transcript.
- Keep the entire summary under 1500 words.`;

const CHARS_PER_TEXT_TOKEN = 3.5;
const CHARS_PER_CJK_TOKEN = 0.9;

function isCjkCodePoint(code: number): boolean {
  return (
    (code >= 0x3000 && code <= 0x4dbf) ||
    (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0x1100 && code <= 0x11ff) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xff00 && code <= 0xffef) ||
    (code >= 0x20000 && code <= 0x3ffff)
  );
}

export function estimateTextTokens(text: string): number {
  let cjkChars = 0;
  let cjkUnits = 0;
  for (let index = 0; index < text.length; index++) {
    const code = text.codePointAt(index) ?? 0;
    const wide = code > 0xffff;
    if (wide) index++;
    if (isCjkCodePoint(code)) {
      cjkChars++;
      cjkUnits += wide ? 2 : 1;
    }
  }
  const latinUnits = text.length - cjkUnits;
  return Math.ceil(cjkChars / CHARS_PER_CJK_TOKEN + latinUnits / CHARS_PER_TEXT_TOKEN);
}

export function estimateConversationTokens(messages: readonly { content: string }[]): number {
  return messages.reduce((sum, message) => sum + 4 + estimateTextTokens(message.content), 0);
}

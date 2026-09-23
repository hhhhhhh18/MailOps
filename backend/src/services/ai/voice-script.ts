import { buildVoiceScriptUser, voiceScriptSystemPrompt, PROMPTS } from "./prompts";
import { voiceScriptOutputSchema } from "./schemas";
import { runAiTask, type AiRunMeta } from "./runner";

export interface VoiceScriptInput {
  company?: string | null;
  role?: string | null;
  statusLabel?: string | null;
  action?: string | null;
  deadline?: string | null;
  severity?: string | null;
}

export interface VoiceScriptResult {
  script: string;
  meta: AiRunMeta;
}

const AI_DISCLOSURE = /automated|automatic|ai assistant|recording|virtual assistant/i;
const MAX_WORDS = 140;

/**
 * Responsibility: VOICE SCRIPTWRITER.
 *
 * Enforces two compliance requirements regardless of which engine produces the
 * text: the agent must disclose that it is automated, and the script must stay
 * short enough to be a summary rather than a reading of the email.
 */
export async function buildVoiceScript(input: VoiceScriptInput): Promise<VoiceScriptResult> {
  const data = {
    company: input.company ?? null,
    role: input.role ?? null,
    statusLabel: input.statusLabel ?? null,
    action: input.action ?? null,
    deadline: input.deadline ?? null,
    severity: input.severity ?? "HIGH",
  };

  const result = await runAiTask({
    task: "voice",
    system: voiceScriptSystemPrompt,
    user: buildVoiceScriptUser(data),
    promptVersion: PROMPTS.voiceScript.version,
    schema: voiceScriptOutputSchema,
    data,
    temperature: 0.2,
    maxTokens: 400,
  });

  let script = result.data.script.trim();

  const words = script.split(/\s+/);
  if (words.length > MAX_WORDS) {
    script = `${words.slice(0, MAX_WORDS).join(" ")}… Open MailOps for the full details.`;
    result.meta.warnings.push("Voice script was truncated to keep the call under the length budget.");
  }

  if (!AI_DISCLOSURE.test(script)) {
    script = `Hi, this is MailOps, an automated AI assistant. ${script}`;
    result.meta.warnings.push("Automated-caller disclosure was prepended to satisfy voice compliance rules.");
  }

  return { script, meta: result.meta };
}

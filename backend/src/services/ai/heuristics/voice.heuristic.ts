export interface VoiceInput {
  company?: string | null;
  role?: string | null;
  statusLabel?: string | null;
  action?: string | null;
  deadline?: string | null;
  severity?: string | null;
}

export interface HeuristicVoiceScript {
  script: string;
}

/**
 * Builds the spoken escalation script.
 *
 * Hard constraints encoded here (product rule #17):
 *  - the agent must identify itself as an automated AI system
 *  - it must summarize, never read the email
 *  - it must not disclose sensitive content
 */
export function buildVoiceScriptHeuristically(input: VoiceInput): HeuristicVoiceScript {
  const company = input.company?.trim() || "an employer";
  const role = input.role?.trim();
  const parts: string[] = [];

  parts.push("Hi, this is MailOps, an automated assistant calling about your job search.");
  parts.push(`You have an important recruitment update from ${company}.`);

  if (role) {
    parts.push(`This concerns your ${role} application.`);
  }

  if (input.statusLabel) {
    parts.push(`Current status: ${input.statusLabel}.`);
  } else {
    parts.push("There is a new update on this application.");
  }

  if (input.action) {
    parts.push(`Action needed: ${input.action}.`);
  }

  if (input.deadline) {
    parts.push(`The deadline is ${input.deadline}.`);
  }

  parts.push("This call is automated and does not read your email contents. Open MailOps for the full details.");

  return { script: parts.join(" ") };
}

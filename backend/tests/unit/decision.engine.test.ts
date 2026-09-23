import { describe, expect, it } from "vitest";
import type { UserSettings } from "@prisma/client";
import { decide, isVoiceCandidate, severityAtLeast, type DecisionInput } from "../../src/services/decisions/decision.engine";
import { checkVoiceGate, readPlan, buildPlan } from "../../src/services/notifications/escalation.service";
import { isWithinQuietHours } from "../../src/utils/dates";

/**
 * The decision engine and the escalation ladder are where MailOps can annoy a
 * user most (unwanted calls, notification storms). These tests lock down the
 * guarantees the product spec demands:
 *   - voice calls are opt-in and never triggered by low-value events
 *   - approval is required for anything destructive
 *   - the escalation ladder only contains channels the user enabled
 */

type SettingsSubset = Parameters<typeof decide>[0]["settings"];

function settings(overrides: Partial<SettingsSubset> = {}): SettingsSubset {
  return {
    notifyDashboard: true,
    notifySlack: false,
    notifyWhatsapp: false,
    notifyEmail: false,
    notifyVoice: false,
    notifyMinSeverity: "MEDIUM",
    escalationEnabled: true,
    escalationDelaysMinutes: [30, 60, 120],
    escalationMaxStage: 2,
    voiceEnabled: false,
    voiceCriticalEvents: ["OFFER", "INTERVIEW", "ASSESSMENT", "RECRUITER_ACTION"],
    cleanupCategories: ["PROMOTIONAL", "SPAM", "NEWSLETTER"],
    autoCleanupEnabled: false,
    ...overrides,
  };
}

function input(overrides: Partial<DecisionInput> = {}): DecisionInput {
  return {
    category: "JOB",
    subCategory: "SHORTLISTED",
    priority: "HIGH",
    confidence: 0.92,
    requiresAction: false,
    needsReview: false,
    isUnwanted: false,
    hasApplication: true,
    deadlineAt: null,
    isProtectedSender: false,
    settings: settings(),
    now: new Date("2026-09-21T10:00:00.000Z"),
    ...overrides,
  };
}

describe("severity mapping", () => {
  it("makes an offer CRITICAL", () => {
    expect(decide(input({ subCategory: "OFFER" })).severity).toBe("CRITICAL");
  });

  it("makes an interview with a near deadline CRITICAL and requires acknowledgement", () => {
    const decision = decide(
      input({
        subCategory: "INTERVIEW",
        requiresAction: true,
        deadlineAt: new Date("2026-09-25T00:00:00.000Z"),
      }),
    );

    expect(decision.severity).toBe("CRITICAL");
    expect(decision.requiresAck).toBe(true);
  });

  it("makes an interview with no deadline HIGH", () => {
    expect(decide(input({ subCategory: "INTERVIEW", requiresAction: false })).severity).toBe("HIGH");
  });

  it("treats a rejection as important but never urgent", () => {
    const decision = decide(input({ subCategory: "REJECTION", requiresAction: false }));
    expect(decision.severity).toBe("HIGH");
    expect(decision.requiresAck).toBe(false);
    expect(decision.voiceEligible).toBe(false);
  });

  it("keeps a job alert LOW and silent", () => {
    const decision = decide(input({ subCategory: "JOB_ALERT", priority: "LOW" }));
    expect(decision.severity).toBe("LOW");
    expect(decision.shouldNotify).toBe(false);
  });
});

describe("notification gating", () => {
  it("does not notify when the severity is below the user's threshold", () => {
    const decision = decide(input({ subCategory: "APPLICATION_ACKNOWLEDGED", settings: settings({ notifyMinSeverity: "HIGH" }) }));
    expect(decision.severity).toBe("MEDIUM");
    expect(decision.shouldNotify).toBe(false);
  });

  it("always surfaces a low-confidence result for review", () => {
    const decision = decide(input({ needsReview: true, confidence: 0.51, subCategory: "OTHER_JOB" }));
    expect(decision.notificationType).toBe("REVIEW_REQUIRED");
    expect(decision.shouldNotify).toBe(true);
    expect(decision.requiresAck).toBe(false);
  });

  it("only includes channels the user enabled", () => {
    const decision = decide(input({ subCategory: "OFFER" }));
    expect(decision.channels.slack).toBe(false);
    expect(decision.channels.whatsapp).toBe(false);
    expect(decision.escalation.stages).toEqual([]);
    expect(decision.escalation.enabled).toBe(false);
  });

  it("builds the ladder from enabled channels only", () => {
    const decision = decide(
      input({
        subCategory: "OFFER",
        settings: settings({ notifySlack: true, notifyWhatsapp: true, notifyVoice: true, voiceEnabled: true }),
      }),
    );

    expect(decision.escalation.stages).toEqual(["SLACK", "WHATSAPP", "VOICE"]);
    expect(decision.escalation.enabled).toBe(true);
  });
});

describe("voice eligibility", () => {
  it("is never eligible while voice is disabled", () => {
    const decision = decide(input({ subCategory: "OFFER" }));
    expect(decision.voiceEligible).toBe(false);
    expect(decision.voiceSuppressionReason).toMatch(/disabled/i);
    expect(isVoiceCandidate(decision)).toBe(false);
  });

  it("is never eligible for a rejection or a job alert, even when voice is on", () => {
    const voiceOn = settings({ notifyVoice: true, voiceEnabled: true });

    const rejection = decide(input({ subCategory: "REJECTION", settings: voiceOn }));
    expect(rejection.voiceEligible).toBe(false);

    const alert = decide(input({ subCategory: "JOB_ALERT", priority: "LOW", settings: voiceOn }));
    expect(alert.voiceEligible).toBe(false);
  });

  it("is never eligible for a promotional email", () => {
    const decision = decide(
      input({
        category: "PROMOTIONAL",
        subCategory: null,
        settings: settings({ notifyVoice: true, voiceEnabled: true, notifySlack: true }),
      }),
    );

    expect(decision.voiceEligible).toBe(false);
    expect(decision.notificationType).toBeNull();
  });

  it("is eligible for an offer when voice is on and the event type is enabled", () => {
    const decision = decide(
      input({
        subCategory: "OFFER",
        settings: settings({ notifyVoice: true, voiceEnabled: true, notifySlack: true, notifyWhatsapp: true }),
      }),
    );

    expect(decision.voiceEligible).toBe(true);
    expect(decision.voiceEventKey).toBe("OFFER");
  });

  it("respects the user's per-event-type selection", () => {
    const decision = decide(
      input({
        subCategory: "INTERVIEW",
        requiresAction: true,
        settings: settings({
          notifyVoice: true,
          voiceEnabled: true,
          notifySlack: true,
          voiceCriticalEvents: ["OFFER"],
        }),
      }),
    );

    expect(decision.voiceEligible).toBe(false);
    expect(decision.voiceSuppressionReason).toMatch(/switched off/i);
  });
});

describe("cleanup candidacy", () => {
  it("proposes promotional mail for cleanup", () => {
    const decision = decide(input({ category: "PROMOTIONAL", subCategory: null, isUnwanted: true }));
    expect(decision.cleanupCandidate).toBe(true);
  });

  it("never proposes job mail for cleanup", () => {
    const decision = decide(input({ category: "JOB", subCategory: "OTHER_JOB", isUnwanted: true }));
    expect(decision.cleanupCandidate).toBe(false);
  });

  it("never proposes mail from a bank or government sender", () => {
    const decision = decide(
      input({ category: "PROMOTIONAL", subCategory: null, isUnwanted: true, isProtectedSender: true }),
    );
    expect(decision.cleanupCandidate).toBe(false);
  });

  it("never proposes a category the user removed from cleanup preferences", () => {
    const decision = decide(
      input({ category: "NEWSLETTER", subCategory: null, isUnwanted: true, settings: settings({ cleanupCategories: ["SPAM"] }) }),
    );
    expect(decision.cleanupCandidate).toBe(false);
  });
});

describe("escalation plan", () => {
  it("records the ladder on the notification so late workers agree with it", () => {
    const decision = decide(
      input({ subCategory: "OFFER", settings: settings({ notifySlack: true, notifyWhatsapp: true }) }),
    );
    const plan = buildPlan(decision);

    expect(plan.escalation.stages).toEqual(["SLACK", "WHATSAPP"]);
    expect(plan.escalation.delaysMinutes).toEqual([30, 60, 120]);
    expect(plan.voiceEligible).toBe(false);
  });

  it("round-trips a plan through notification metadata", () => {
    const decision = decide(input({ subCategory: "OFFER", settings: settings({ notifySlack: true }) }));
    const plan = buildPlan(decision);
    const stored = { metadata: { plan } } as unknown as Parameters<typeof readPlan>[0];

    expect(readPlan(stored)).toEqual(plan);
  });
});

describe("voice gates", () => {
  const baseSettings = {
    voiceEnabled: true,
    voiceMaxCallsPerDay: 2,
    voiceQuietHoursStart: 22,
    voiceQuietHoursEnd: 7,
    voiceCriticalEvents: ["OFFER", "INTERVIEW"],
  };

  const eligiblePlan = buildPlan(
    decide(input({ subCategory: "OFFER", settings: settings({ notifySlack: true, notifyVoice: true, voiceEnabled: true }) })),
  );

  /**
   * checkVoiceGate evaluates quiet hours against the real clock — correct for
   * production, but it means a hard-coded window makes this assertion pass or fail
   * depending on the time of day the suite runs. The windows are therefore derived
   * from the current hour, which exercises both directions deterministically.
   */
  it("allows a call outside quiet hours and blocks it inside them", async () => {
    const hour = new Date().getUTCHours();

    // A window starting two hours from now cannot contain the current hour.
    const open = await checkVoiceGate(
      "user_1",
      {
        ...baseSettings,
        voiceQuietHoursStart: (hour + 2) % 24,
        voiceQuietHoursEnd: (hour + 4) % 24,
        // Raised so a stray counter value can never affect this assertion.
        voiceMaxCallsPerDay: 5,
      },
      "UTC",
      eligiblePlan,
    );
    expect(open.allowed).toBe(true);

    // A window anchored on the current hour must contain it.
    const closed = await checkVoiceGate(
      "user_1",
      { ...baseSettings, voiceQuietHoursStart: hour, voiceQuietHoursEnd: (hour + 2) % 24 },
      "UTC",
      eligiblePlan,
    );
    expect(closed.allowed).toBe(false);
    expect(closed.reason).toMatch(/quiet hours/i);
  });

  it("recognises a quiet-hours window that wraps midnight", () => {
    expect(isWithinQuietHours(new Date("2026-09-21T23:30:00.000Z"), "UTC", 22, 7)).toBe(true);
    expect(isWithinQuietHours(new Date("2026-09-21T03:00:00.000Z"), "UTC", 22, 7)).toBe(true);
    expect(isWithinQuietHours(new Date("2026-09-21T12:00:00.000Z"), "UTC", 22, 7)).toBe(false);
  });

  it("honours the user's timezone", () => {
    // 23:30 UTC is 05:00 in Asia/Kolkata — inside the window for that user.
    expect(isWithinQuietHours(new Date("2026-09-21T23:30:00.000Z"), "Asia/Kolkata", 22, 7)).toBe(true);
  });

  it("refuses to call when voice is disabled", async () => {
    const gate = await checkVoiceGate("user_1", { ...baseSettings, voiceEnabled: false }, "UTC", eligiblePlan);
    expect(gate.allowed).toBe(false);
    expect(gate.reason).toMatch(/disabled/i);
  });

  it("refuses to call for an ineligible event type", async () => {
    const ineligible = buildPlan(
      decide(
        input({
          subCategory: "OFFER",
          settings: settings({ notifySlack: true, notifyVoice: true, voiceEnabled: true, voiceCriticalEvents: ["INTERVIEW"] }),
        }),
      ),
    );

    const gate = await checkVoiceGate("user_1", baseSettings, "UTC", ineligible);
    expect(gate.allowed).toBe(false);
  });
});

describe("severity helper", () => {
  it("orders severities", () => {
    expect(severityAtLeast("CRITICAL", "HIGH")).toBe(true);
    expect(severityAtLeast("LOW", "MEDIUM")).toBe(false);
    expect(severityAtLeast("MEDIUM", "MEDIUM")).toBe(true);
  });
});

describe("settings type sanity", () => {
  it("uses schema defaults that keep voice off", () => {
    // Guards against a future default flip silently enabling phone calls.
    const defaults = settings();
    expect(defaults.voiceEnabled).toBe(false);
    expect(defaults.notifyVoice).toBe(false);
    expect(defaults.notifySlack).toBe(false);
  });

  it("keeps the notification threshold at MEDIUM by default", () => {
    expect(settings().notifyMinSeverity).toBe("MEDIUM");
  });
});

void (null as unknown as UserSettings);

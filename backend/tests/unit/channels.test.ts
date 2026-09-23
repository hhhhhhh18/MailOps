import { describe, expect, it, vi, afterEach } from "vitest";
import { getChannel, CHANNELS } from "../../src/services/notifications/channels";
import { absoluteActionUrl } from "../../src/services/notifications/channels/types";
import { buildNotificationContent, buildDedupeKey } from "../../src/services/notifications/notification.service";
import { buildVoiceScriptHeuristically } from "../../src/services/ai/heuristics/voice.heuristic";
import { buildVoiceScript } from "../../src/services/ai/voice-script";
import type { ChannelPayload } from "../../src/services/notifications/channels/types";

/**
 * Channel behaviour. The two things that must never regress:
 *   - a broken/unconfigured channel reports "skipped" rather than throwing, so it
 *     cannot take down the escalation ladder (graceful degradation)
 *   - the voice script always discloses that the caller is automated
 */

const payload: ChannelPayload = {
  title: "Microsoft — Software Engineer: shortlisted",
  body: "The recruiter moved your application to the next stage.",
  actionUrl: "https://app.mailops.local/applications/app_1",
  actionLabel: "Open in MailOps",
  severity: "HIGH",
  company: "Microsoft",
  role: "Software Engineer",
  status: "Shortlisted",
  deadline: "2026-09-25",
  notificationId: "notif_1",
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("channel registry", () => {
  it("registers every channel referenced by the escalation ladder", () => {
    expect(Object.keys(CHANNELS).sort()).toEqual(["DASHBOARD", "EMAIL", "SLACK", "VOICE", "WHATSAPP"]);
    expect(getChannel("SLACK").id).toBe("SLACK");
  });

  it("reports the dashboard as always configured", () => {
    expect(getChannel("DASHBOARD").isConfigured({ config: {}, secrets: {} })).toBe(true);
  });

  it("reports Slack as unconfigured without a webhook", () => {
    const result = getChannel("SLACK").isConfigured({ config: {}, secrets: {} });
    expect(result).toBe(false);
  });

  it("reports WhatsApp as unconfigured without credentials", () => {
    expect(getChannel("WHATSAPP").isConfigured({ config: {}, secrets: {} })).toBe(false);
  });

  it("reports voice as unconfigured without provider credentials", () => {
    expect(getChannel("VOICE").isConfigured({ config: {}, secrets: {} })).toBe(false);
  });
});

describe("graceful degradation", () => {
  it("dashboard delivery always succeeds without an external call", async () => {
    const result = await getChannel("DASHBOARD").send(payload, { config: {}, secrets: {} });
    expect(result.ok).toBe(true);
    expect(result.skipped).toBe(false);
  });

  it("returns skipped (not an exception) when Slack has no webhook", async () => {
    const result = await getChannel("SLACK").send(payload, { config: {}, secrets: {} });
    expect(result.ok).toBe(false);
    expect(result.skipped).toBe(true);
    expect(result.error).toMatch(/webhook/i);
  });

  it("returns skipped when WhatsApp is not configured", async () => {
    const result = await getChannel("WHATSAPP").send(payload, { config: {}, secrets: {} });
    expect(result.skipped).toBe(true);
  });

  it("reports a failed Slack delivery without throwing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("invalid_payload", { status: 400 })),
    );

    const result = await getChannel("SLACK").send(payload, {
      config: {},
      secrets: { webhookUrl: "https://hooks.slack.com/services/test" },
    });

    expect(result.ok).toBe(false);
    expect(result.skipped).toBe(false);
    expect(result.error).toMatch(/400/);
  });

  it("reports a network error on Slack as a failure, not a crash", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("getaddrinfo ENOTFOUND hooks.slack.com");
      }),
    );

    const result = await getChannel("SLACK").send(payload, {
      config: {},
      secrets: { webhookUrl: "https://hooks.slack.com/services/test" },
    });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/ENOTFOUND/);
  });

  it("never sends the email body to Slack", async () => {
    const fetchMock = vi.fn(async () => new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await getChannel("SLACK").send(payload, {
      config: {},
      secrets: { webhookUrl: "https://hooks.slack.com/services/test" },
    });

    const body = String((fetchMock.mock.calls[0] as unknown[])[1] ? JSON.stringify((fetchMock.mock.calls[0] as unknown[])[1]) : "");
    expect(body).toContain("Microsoft");
    expect(body).not.toContain("bodyText");
    expect(body).not.toContain("snippet");
  });
});

describe("voice compliance", () => {
  it("blocks a call whose script does not disclose that it is automated", async () => {
    const result = await getChannel("VOICE").send(
      { ...payload, metadata: { voiceScript: "Hi, you have an update from Microsoft." } },
      {
        config: { to: "+919800000021", fromNumber: "+15005550006" },
        secrets: { accountSid: "AC123", authToken: "token" },
      },
    );

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/disclosure/i);
  });

  it("generates a script that identifies the caller as automated", () => {
    const { script } = buildVoiceScriptHeuristically({
      company: "Microsoft",
      role: "Software Engineer",
      statusLabel: "Shortlisted",
      action: "Complete the assessment",
      deadline: "2026-09-25",
    });

    expect(script).toMatch(/automated/i);
    expect(script).toContain("Microsoft");
    expect(script).toContain("Software Engineer");
    expect(script).toContain("2026-09-25");
  });

  it("adds the disclosure when a provider omits it", async () => {
    const result = await buildVoiceScript({ company: "Amazon", role: "Cloud Engineer", statusLabel: "Offer" });
    expect(result.script).toMatch(/automated/i);
  });

  it("truncates an over-long script", async () => {
    const result = await buildVoiceScript({
      company: "Amazon",
      role: "Cloud Engineer",
      statusLabel: "Offer",
      action: "respond to the offer and confirm the joining date with the hiring manager team",
      deadline: "2026-09-30",
      severity: "CRITICAL",
    });

    expect(result.script.split(/\s+/).length).toBeLessThanOrEqual(160);
  });
});

describe("notification content", () => {
  it("builds a title naming the company and role", () => {
    const content = buildNotificationContent({
      type: "RECRUITER_ACTION",
      severity: "HIGH",
      analysis: { category: "JOB", subCategory: "SHORTLISTED", summary: "Shortlisted for the role.", confidence: 0.95, reasoning: "Detected because the email uses shortlisting language." },
      application: { id: "app_1", company: "Microsoft", role: "Software Engineer", status: "SHORTLISTED" },
      email: null,
      deadline: null,
      requiredAction: null,
    });

    expect(content.title).toContain("Microsoft");
    expect(content.title).toContain("Software Engineer");
    expect(content.actionUrl).toBe("/applications/app_1");
  });

  it("does not quote more than the subject when the analysis is uncertain", () => {
    const content = buildNotificationContent({
      type: "REVIEW_REQUIRED",
      severity: "MEDIUM",
      analysis: { category: "JOB", subCategory: null, summary: null, confidence: 0.55, reasoning: "Not enough signal." },
      application: null,
      email: {
        id: "email_1",
        subject: "Quick question about your availability",
        fromName: "Recruiting Team",
        fromEmail: "talent@brightstack.io",
        receivedAt: new Date(),
      },
      deadline: null,
      requiredAction: null,
    });

    expect(content.title).toContain("Quick question about your availability");
    expect(content.actionUrl).toBe("/emails?emailId=email_1");
  });

  it("produces a stable dedupe key for the same event", () => {
    const a = buildDedupeKey({ type: "RECRUITER_ACTION", emailId: "email_1", applicationId: "app_1", subCategory: "INTERVIEW" });
    const b = buildDedupeKey({ type: "RECRUITER_ACTION", emailId: "email_1", applicationId: "app_1", subCategory: "INTERVIEW" });
    expect(a).toBe(b);
    expect(a.length).toBeLessThanOrEqual(190);
  });

  it("distinguishes different events", () => {
    const a = buildDedupeKey({ type: "RECRUITER_ACTION", emailId: "email_1", subCategory: "INTERVIEW" });
    const b = buildDedupeKey({ type: "RECRUITER_ACTION", emailId: "email_2", subCategory: "INTERVIEW" });
    expect(a).not.toBe(b);
  });
});

describe("action URL handling", () => {
  it("makes a relative path absolute for external channels", () => {
    expect(absoluteActionUrl("/applications/app_1", "https://app.mailops.local")).toBe(
      "https://app.mailops.local/applications/app_1",
    );
  });

  it("leaves an absolute URL untouched", () => {
    expect(absoluteActionUrl("https://example.com/x", "https://app.mailops.local")).toBe("https://example.com/x");
  });

  it("returns null when there is no action", () => {
    expect(absoluteActionUrl(null, "https://app.mailops.local")).toBeNull();
  });
});

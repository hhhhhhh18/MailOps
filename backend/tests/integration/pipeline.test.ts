/**
 * End-to-end pipeline tests against a real database.
 *
 * Gated behind RUN_INTEGRATION_TESTS=true because they require PostgreSQL (and a
 * clean schema). They never touch a real Gmail account: messages are inserted
 * directly, which is exactly what the Gmail normaliser produces, so the rest of
 * the pipeline is exercised faithfully.
 *
 *   docker compose up -d postgres
 *   npm run prisma:deploy
 *   RUN_INTEGRATION_TESTS=true npm test
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../../src/config/prisma";
import { integrationEnabled } from "../setup";

const describeIntegration = integrationEnabled ? describe : describe.skip;

const TEST_EMAIL = "pipeline-test@mailops.local";

describeIntegration("email -> application -> notification", () => {
  let userId = "";
  let gmailAccountId = "";

  beforeAll(async () => {
    // Clean any leftovers from a previous interrupted run.
    await prisma.user.deleteMany({ where: { email: TEST_EMAIL } });

    const user = await prisma.user.create({
      data: {
        email: TEST_EMAIL,
        name: "Pipeline Test",
        timezone: "UTC",
        settings: {
          create: {
            notifyDashboard: true,
            notifySlack: false,
            notifyWhatsapp: false,
            notifyVoice: false,
            escalationEnabled: true,
            escalationDelaysMinutes: [30, 60, 120],
          },
        },
      },
    });
    userId = user.id;

    const account = await prisma.gmailAccount.create({
      data: {
        userId,
        emailAddress: "pipeline-test@gmail.com",
        status: "DISCONNECTED",
        grantedScopes: [],
      },
    });
    gmailAccountId = account.id;
  });

  afterAll(async () => {
    if (userId) await prisma.user.deleteMany({ where: { id: userId } });
    await prisma.$disconnect();
  });

  async function insertEmail(input: {
    gmailMessageId: string;
    subject: string;
    body: string;
    fromEmail: string;
    fromName?: string;
    receivedAt?: Date;
  }) {
    return prisma.email.create({
      data: {
        userId,
        gmailAccountId,
        gmailMessageId: input.gmailMessageId,
        gmailThreadId: `thread-${input.gmailMessageId}`,
        fromEmail: input.fromEmail,
        fromName: input.fromName ?? "Careers",
        toEmail: "pipeline-test@gmail.com",
        subject: input.subject,
        snippet: input.body.slice(0, 150),
        bodyText: input.body,
        receivedAt: input.receivedAt ?? new Date(),
        labels: ["INBOX"],
        processingState: "QUEUED",
      },
    });
  }

  it("is idempotent: the same gmailMessageId cannot be stored twice", async () => {
    const email = await insertEmail({
      gmailMessageId: "dup-check-1",
      subject: "Thank you for applying",
      body: "Thank you for applying to Acme for the Analyst role.",
      fromEmail: "careers@acme.com",
    });

    await expect(
      insertEmail({
        gmailMessageId: "dup-check-1",
        subject: "Thank you for applying",
        body: "Thank you for applying to Acme for the Analyst role.",
        fromEmail: "careers@acme.com",
      }),
    ).rejects.toThrow();

    await prisma.email.delete({ where: { id: email.id } });
  });

  it("creates an application, a timeline event and a notification from a shortlist email", async () => {
    const { analyzeEmail } = await import("../../src/services/ai/analysis.service");
    const { processApplicationFromEmail } = await import(
      "../../src/services/applications/application-processing.service"
    );

    const email = await insertEmail({
      gmailMessageId: "shortlist-1",
      subject: "Congratulations! You have been shortlisted",
      body:
        "Congratulations! We are pleased to inform you that your profile has been shortlisted for the Software Engineer position at Contoso. Job ID: CT-10021. Location: Hyderabad.",
      fromEmail: "careers@contoso.com",
    });

    const analysis = await analyzeEmail(email.id);
    expect(analysis.category).toBe("JOB");
    expect(analysis.subCategory).toBe("SHORTLISTED");
    expect(analysis.analysisId).toBeTruthy();

    const outcome = await processApplicationFromEmail({
      userId,
      emailId: email.id,
      analysisId: analysis.analysisId as string,
    });

    expect(outcome.outcome).toBe("CREATED_APPLICATION");
    expect(outcome.applicationId).toBeTruthy();

    const application = await prisma.application.findUnique({
      where: { id: outcome.applicationId as string },
      include: { events: true },
    });

    expect(application).not.toBeNull();
    expect(application!.company).toBe("Contoso");
    expect(application!.role).toBe("Software Engineer");
    expect(application!.status).toBe("SHORTLISTED");
    expect(application!.events.length).toBeGreaterThanOrEqual(2);
    expect(application!.events.some((e) => e.type === "APPLICATION_CREATED")).toBe(true);

    // A HIGH severity event with no action required notifies the dashboard but
    // does not require acknowledgement.
    if (outcome.notificationId) {
      const notification = await prisma.notification.findUnique({ where: { id: outcome.notificationId } });
      expect(notification).not.toBeNull();
      expect(notification!.severity).toBe("HIGH");
    }
  });

  it("links a follow-up email to the existing application instead of creating a second one", async () => {
    const { analyzeEmail } = await import("../../src/services/ai/analysis.service");
    const { processApplicationFromEmail } = await import(
      "../../src/services/applications/application-processing.service"
    );

    const before = await prisma.application.count({ where: { userId } });

    const email = await insertEmail({
      gmailMessageId: "interview-1",
      subject: "Interview invitation — Software Engineer at Contoso",
      body:
        "We would like to invite you to a technical interview for the Software Engineer position at Contoso. Job ID: CT-10021. Please confirm a slot before September 30, 2026.",
      fromEmail: "careers@contoso.com",
    });

    const analysis = await analyzeEmail(email.id);
    const outcome = await processApplicationFromEmail({
      userId,
      emailId: email.id,
      analysisId: analysis.analysisId as string,
    });

    expect(outcome.outcome).toBe("LINKED_TO_APPLICATION");
    expect(outcome.statusChanged).toBe(true);

    const after = await prisma.application.count({ where: { userId } });
    expect(after).toBe(before);

    const application = await prisma.application.findFirst({ where: { userId, company: "Contoso" } });
    expect(application!.status).toBe("INTERVIEW");
    expect(application!.jobId).toBe("CT-10021");
  });

  it("never rewinds a status when an older email arrives late", async () => {
    const { applyEmailToApplication } = await import("../../src/services/applications/application.service");

    const application = await prisma.application.findFirst({ where: { userId, company: "Contoso" } });
    expect(application!.status).toBe("INTERVIEW");

    const lateEmail = await insertEmail({
      gmailMessageId: "late-ack-1",
      subject: "Your application has been received",
      body: "Thank you for applying. Your application has been received and is under review.",
      fromEmail: "careers@contoso.com",
      receivedAt: new Date(Date.now() - 30 * 86_400_000),
    });

    const result = await applyEmailToApplication({
      userId,
      emailId: lateEmail.id,
      applicationId: application!.id,
      subCategory: "APPLICATION_ACKNOWLEDGED",
      category: "JOB",
      priority: "MEDIUM",
      confidence: 0.9,
      requiresAction: false,
    });

    expect(result.statusChanged).toBe(false);
    expect(result.toStatus).toBe("INTERVIEW");

    const unchanged = await prisma.application.findUnique({ where: { id: application!.id } });
    expect(unchanged!.status).toBe("INTERVIEW");
  });

  it("persists a rejection and keeps it after the email is deleted", async () => {
    const { analyzeEmail } = await import("../../src/services/ai/analysis.service");
    const { processApplicationFromEmail } = await import(
      "../../src/services/applications/application-processing.service"
    );

    const application = await prisma.application.findFirst({ where: { userId, company: "Contoso" } });

    const email = await insertEmail({
      gmailMessageId: "rejection-1",
      subject: "Update on your application",
      body:
        "We regret to inform you that we will not be moving forward with your application for the Software Engineer position at Contoso. We wish you the best.",
      fromEmail: "careers@contoso.com",
    });

    const analysis = await analyzeEmail(email.id);
    await processApplicationFromEmail({ userId, emailId: email.id, analysisId: analysis.analysisId as string });

    const rejected = await prisma.application.findUnique({ where: { id: application!.id } });
    expect(rejected!.status).toBe("REJECTED");

    const rejectionEvent = await prisma.applicationEvent.findFirst({
      where: { applicationId: application!.id, type: "REJECTION_RECEIVED" },
    });
    expect(rejectionEvent).not.toBeNull();

    // Now simulate the user deleting the Gmail message through MailOps.
    await prisma.email.update({
      where: { id: email.id },
      data: { deletedFromGmail: true, deletedFromMailops: new Date() },
    });
    await prisma.applicationEvent.updateMany({ where: { emailId: email.id }, data: { emailId: null } });
    await prisma.email.delete({ where: { id: email.id } });

    const survivor = await prisma.application.findUnique({
      where: { id: application!.id },
      include: { events: { where: { type: "REJECTION_RECEIVED" } } },
    });

    expect(survivor).not.toBeNull();
    expect(survivor!.status).toBe("REJECTED");
    expect(survivor!.events).toHaveLength(1);
    expect(survivor!.events[0].title).toBeTruthy();
  });

  it("creates a cleanup proposal for promotional mail and never for job mail", async () => {
    const { analyzeEmail } = await import("../../src/services/ai/analysis.service");
    const { processApplicationFromEmail } = await import(
      "../../src/services/applications/application-processing.service"
    );

    const promo = await insertEmail({
      gmailMessageId: "promo-1",
      subject: "Mega sale — flat 60% off everything",
      body: "Shop now and save up to 60%. Use coupon code SAVE60. Free shipping. Unsubscribe from this list.",
      fromEmail: "deals@shopmart.com",
    });

    const promoAnalysis = await analyzeEmail(promo.id);
    const promoOutcome = await processApplicationFromEmail({
      userId,
      emailId: promo.id,
      analysisId: promoAnalysis.analysisId as string,
    });

    expect(promoOutcome.outcome).toBe("CLEANUP_PROPOSED");

    const proposal = await prisma.cleanupAction.findFirst({ where: { userId, emailId: promo.id } });
    expect(proposal).not.toBeNull();
    expect(proposal!.status).toBe("PROPOSED");

    // A job email must never reach the cleanup queue, even though it has an
    // unsubscribe footer.
    const jobEmail = await insertEmail({
      gmailMessageId: "job-with-footer-1",
      subject: "Thank you for applying to Fabrikam",
      body:
        "Thank you for applying. We have received your application for the Data Analyst role at Fabrikam. Unsubscribe from this list.",
      fromEmail: "careers@fabrikam.com",
    });

    const jobAnalysis = await analyzeEmail(jobEmail.id);
    const jobOutcome = await processApplicationFromEmail({
      userId,
      emailId: jobEmail.id,
      analysisId: jobAnalysis.analysisId as string,
    });

    expect(jobOutcome.outcome).toBe("CREATED_APPLICATION");
    const jobProposal = await prisma.cleanupAction.findFirst({ where: { userId, emailId: jobEmail.id } });
    expect(jobProposal).toBeNull();
  });

  it("blocks a cleanup approval for a protected email", async () => {
    const { executeCleanupBatch } = await import("../../src/services/cleanup/cleanup.service");

    // Directly attempt to have a recruiter email deleted.
    const recruiterEmail = await prisma.email.findFirst({ where: { userId, gmailMessageId: "interview-1" } });
    expect(recruiterEmail).not.toBeNull();

    const result = await executeCleanupBatch({
      userId,
      emailIds: [recruiterEmail!.id],
      action: "DELETE",
    });

    expect(result.executed).toBe(0);
    expect(result.blocked).toHaveLength(1);
    expect(result.blocked[0].reason).toMatch(/never deleted|evidence|protected/i);

    // The email record must still exist.
    const stillThere = await prisma.email.findUnique({ where: { id: recruiterEmail!.id } });
    expect(stillThere).not.toBeNull();
  });

  it("records an audit entry for the classified email", async () => {
    const audit = await prisma.auditLog.findFirst({
      where: { userId, action: { in: ["email.classified", "email.needs_review"] } },
      orderBy: { createdAt: "desc" },
    });

    expect(audit).not.toBeNull();
    expect(audit!.summary).toBeTruthy();
  });

  it("re-analysing a processed email is a no-op unless forced", async () => {
    const { analyzeEmail } = await import("../../src/services/ai/analysis.service");
    const email = await prisma.email.findFirst({ where: { userId, gmailMessageId: "shortlist-1" } });
    expect(email).not.toBeNull();

    const result = await analyzeEmail(email!.id);
    expect(result.skipped).toBe(true);

    const forced = await analyzeEmail(email!.id, { force: true });
    expect(forced.skipped).toBe(false);
  });
});

describeIntegration("retention sweep", () => {
  it("trims bodies past retention but keeps the application history", async () => {
    const { runRetentionSweep } = await import("../../src/services/cleanup/cleanup.service");

    const user = await prisma.user.create({
      data: {
        email: "retention-test@mailops.local",
        settings: { create: { dataRetentionDays: 7, storeEmailBody: true } },
      },
    });

    const account = await prisma.gmailAccount.create({
      data: { userId: user.id, emailAddress: "retention@gmail.com", status: "DISCONNECTED", grantedScopes: [] },
    });

    const old = new Date(Date.now() - 30 * 86_400_000);

    const application = await prisma.application.create({
      data: {
        userId: user.id,
        company: "OldCorp",
        role: "Analyst",
        status: "REJECTED",
        companyKey: "oldcorp",
        roleKey: "analyst",
        appliedDate: old,
      },
    });

    const email = await prisma.email.create({
      data: {
        userId: user.id,
        gmailAccountId: account.id,
        gmailMessageId: "retention-old-1",
        fromEmail: "careers@oldcorp.com",
        subject: "Update on your application",
        bodyText: "We regret to inform you that we will not be moving forward.",
        receivedAt: old,
        processingState: "PROCESSED",
        applicationId: application.id,
      },
    });

    const result = await runRetentionSweep(user.id);
    expect(result.bodiesTrimmed).toBeGreaterThanOrEqual(1);

    const trimmed = await prisma.email.findUnique({ where: { id: email.id } });
    expect(trimmed!.bodyText).toBeNull();

    // Application history survives.
    const survivor = await prisma.application.findUnique({ where: { id: application.id } });
    expect(survivor).not.toBeNull();

    await prisma.user.delete({ where: { id: user.id } });
  });
});

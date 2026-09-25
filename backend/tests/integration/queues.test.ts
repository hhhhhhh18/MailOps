import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { enqueueProcessEmail, queues } from "../../src/queues";

const TEST_EMAIL_ID = "queue-regression-email-123";

describe("email processing queue producer", () => {
  beforeEach(async () => {
    const queue = queues.emailProcessing;

    // Remove any jobs left by a previous interrupted test run.
    const jobs = await queue.getJobs([
      "waiting",
      "active",
      "completed",
      "failed",
      "delayed",
    ]);

    for (const job of jobs) {
      if (job.data?.emailId === TEST_EMAIL_ID) {
        await job.remove().catch(() => undefined);
      }
    }
  });

  afterAll(async () => {
    const queue = queues.emailProcessing;

    const jobs = await queue.getJobs([
      "waiting",
      "active",
      "completed",
      "failed",
      "delayed",
    ]);

    for (const job of jobs) {
      if (job.data?.emailId === TEST_EMAIL_ID) {
        await job.remove().catch(() => undefined);
      }
    }

    await queue.close();
  });

  it("enqueues normal email processing with a valid BullMQ job id", async () => {
    const jobId = await enqueueProcessEmail({
      emailId: TEST_EMAIL_ID,
      userId: "queue-test-user",
    });

    expect(jobId).toBe(`email-${TEST_EMAIL_ID}`);

    const job = await queues.emailProcessing.getJob(jobId!);

    expect(job).toBeDefined();
    expect(job?.data).toMatchObject({
      emailId: TEST_EMAIL_ID,
      userId: "queue-test-user",
    });
  });

  it("creates a distinct valid job id when forced", async () => {
    const normalJobId = await enqueueProcessEmail({
      emailId: TEST_EMAIL_ID,
      userId: "queue-test-user",
    });

    const forcedJobId = await enqueueProcessEmail(
      {
        emailId: TEST_EMAIL_ID,
        userId: "queue-test-user",
        force: true,
      },
      { required: true },
    );

    expect(normalJobId).toBe(`email-${TEST_EMAIL_ID}`);
    expect(forcedJobId).toMatch(
      new RegExp(`^email-${TEST_EMAIL_ID}-\\d+$`),
    );
    expect(forcedJobId).not.toBe(normalJobId);

    const forcedJob = await queues.emailProcessing.getJob(forcedJobId!);

    expect(forcedJob).toBeDefined();
    expect(forcedJob?.data).toMatchObject({
      emailId: TEST_EMAIL_ID,
      userId: "queue-test-user",
      force: true,
    });
  });
});
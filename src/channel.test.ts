import { describe, expect, it } from "vitest";
import { parseInboundEmail } from "./jmap-client.js";
import { classifyEmailAutomation } from "./jmap-email.js";

describe("parseInboundEmail", () => {
  it("extracts core inbound fields", () => {
    const parsed = parseInboundEmail({
      email: {
        id: "m1",
        threadId: "t1",
        from: [{ email: "Alice@Example.com", name: "Alice" }],
        subject: "Hello",
        preview: "Preview text",
      },
    });

    expect(parsed).toBeTruthy();
    expect(parsed?.threadId).toBe("t1");
    expect(parsed?.senderEmail).toBe("alice@example.com");
    expect(parsed?.subject).toBe("Hello");
    expect(parsed?.text).toBe("Preview text");
  });

  it("labels automated email for inspection while suppressing replies elsewhere", () => {
    const parsed = parseInboundEmail({
      email: {
        id: "m2",
        threadId: "t2",
        from: [{ email: "mailer-daemon@example.com" }],
        preview: "Delivery status notification",
        "header:Auto-Submitted:asText": "auto-generated",
      },
    });

    expect(parsed).toMatchObject({
      senderEmail: "mailer-daemon@example.com",
      automated: true,
    });
  });

  it("classifies mailing lists and delivery reports with explainable reasons", () => {
    expect(
      classifyEmailAutomation({
        id: "list-1",
        from: [{ email: "updates@example.com" }],
        "header:List-Unsubscribe:asText": "<https://example.com/unsubscribe>",
      }),
    ).toEqual({
      automated: true,
      suppressReply: true,
      reasons: ["mailing-list"],
    });
    expect(
      classifyEmailAutomation({
        id: "dsn-1",
        from: [{ email: "postmaster@example.com" }],
        "header:Return-Path:asText": "<>",
        "header:Content-Type:asText":
          "multipart/report; report-type=delivery-status; boundary=x",
      }),
    ).toEqual({
      automated: true,
      suppressReply: true,
      reasons: [
        "empty-return-path",
        "delivery-status",
        "automated-sender",
      ],
    });
  });
});

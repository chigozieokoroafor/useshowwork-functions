import { CONTENT_WORKSPACE_PLANS } from "@/lib/contentWorkspaceEntitlements";
import { Resend } from "resend";
import {nativeApplicationContext} from '@/lib/publishing/nativeApplicationContext';

const resend = new Resend(process.env.RESEND_API_KEY);

const APP_URL =
  process.env.NEXT_PUBLIC_APP_URL ?? "https://useshowwork.com";

const FROM =
  process.env.RESEND_FROM_EMAIL ?? "Showwork <onboarding@resend.dev>";

const SHOWWORK_LOGO_URL =
  "https://useshowwork.com/images/logo/sw.png";

const CREATIVO_LOGO_URL =
  "https://useshowwork.com/images/logo/creativo.png";

type EmailPayload = Parameters<typeof resend.emails.send>[0];

/**
 * Central email sender.
 * Keep email delivery independent of the local filesystem and inline attachments.
 * Brand images are referenced through absolute HTTPS URLs from the public site.
 */
async function sendEmail(input: EmailPayload, idempotencyKey?: string) {
  const scoped=nativeApplicationContext();
  if(scoped&&!scoped.notify)throw Error('EXPLICIT_NOTIFICATION_PORT_REQUIRED');
  const { data, error } = scoped?await scoped.notify!(input as unknown as Record<string,unknown>,idempotencyKey):await resend.emails.send(input, idempotencyKey ? { idempotencyKey } : undefined);

  if (error) {
    console.error("[Showwork email] Resend send failed", {
      to: input.to,
      subject: input.subject,
      error,
    });
    throw new Error(
      typeof error === "object" && error && "message" in error
        ? String(error.message)
        : "Email delivery failed",
    );
  }

  return data;
}
const HERO_IMAGE_URL = `${APP_URL}/images/hero1.png`;
const COMMUNITY_URL =
  "https://chat.whatsapp.com/GVRHGFaFW5Z0yOOWbWmrn0?mode=gi_t";

/**
 * Email design system
 * ---------------------------------------------------------------------------
 * These emails deliberately use table-friendly HTML, inline styles and
 * conservative CSS so they survive Gmail, Outlook, Apple Mail and mobile
 * clients without losing the visual hierarchy.
 *
 * Brand rule:
 * - Showwork emails use the Showwork logo.
 * - Emails that mention Creativo use BOTH the Showwork and Creativo logos.
 * - Email-safe PNG logos are loaded from the public Showwork domain.
 * - Showwork's black logo sits on a white brand tile.
 * - Creativo's white logo sits on a dark brand tile.
 *
 * This avoids logos disappearing into the background while keeping the source
 * assets untouched.
 */

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function firstNameOf(name?: string | null): string | null {
  const value = name?.trim();
  return value ? value.split(/\s+/)[0] : null;
}

function logoTile(dualBrand = false): string {
  if (dualBrand) {
    return `
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center">
        <tr>
          <td style="padding-right:8px;">
            <div style="display:inline-block;padding:10px 14px;background:#FFFFFF;border:1px solid #E5E7EB;border-radius:12px;">
              <img src="${SHOWWORK_LOGO_URL}" alt="Showwork" width="112" style="display:block;width:112px;height:auto;max-height:28px;" />
            </div>
          </td>
          <td style="padding-left:8px;">
            <div style="display:inline-block;padding:10px 14px;background:#111827;border:1px solid #263246;border-radius:12px;">
              <img src="${CREATIVO_LOGO_URL}" alt="Creativo" width="96" style="display:block;width:96px;height:auto;max-height:28px;" />
            </div>
          </td>
        </tr>
      </table>
    `;
  }

  return `
    <div style="display:inline-block;padding:11px 16px;background:#FFFFFF;border:1px solid #E5E7EB;border-radius:12px;">
      <img src="${SHOWWORK_LOGO_URL}" alt="Showwork" width="124" style="display:block;width:124px;height:auto;max-height:30px;" />
    </div>
  `;
}

function emailShell({
  eyebrow,
  headline,
  body,
  ctaLabel,
  ctaUrl,
  detailsHtml = "",
  heroImage = false,
  dualBrand = false,
  accent = "#2478FF",
  footer = "You're receiving this because of activity on Showwork.",
}: {
  eyebrow: string;
  headline: string;
  body: string;
  ctaLabel?: string;
  ctaUrl?: string;
  detailsHtml?: string;
  heroImage?: boolean;
  dualBrand?: boolean;
  accent?: string;
  footer?: string;
}): string {
  const safeEyebrow = escapeHtml(eyebrow);
  const safeHeadline = escapeHtml(headline);
  const safeBody = body;
  const safeCtaLabel = ctaLabel ? escapeHtml(ctaLabel) : "";
  const safeCtaUrl = ctaUrl ? escapeHtml(ctaUrl) : "";

  return `
<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta name="color-scheme" content="light" />
  <meta name="supported-color-schemes" content="light" />
  <title>Showwork</title>
</head>
<body style="margin:0;padding:0;background:#EEF2F7;">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">
    ${safeEyebrow} — ${safeHeadline}
  </div>

  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#EEF2F7;">
    <tr>
      <td align="center" style="padding:36px 14px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;">

          <tr>
            <td align="center" style="padding:0 0 20px;">
              ${logoTile(dualBrand)}
            </td>
          </tr>

          <tr>
            <td>
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
                style="background:#0B1220;border-radius:24px 24px 0 0;overflow:hidden;">
                <tr>
                  <td style="height:5px;background:${accent};font-size:0;line-height:0;">&nbsp;</td>
                </tr>
                ${
                  heroImage
                    ? `
                <tr>
                  <td>
                    <img src="${HERO_IMAGE_URL}" alt="" width="600"
                      style="display:block;width:100%;height:210px;object-fit:cover;background:#111827;" />
                  </td>
                </tr>`
                    : ""
                }
                <tr>
                  <td style="padding:34px 34px 36px;">
                    <p style="margin:0 0 13px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;font-size:11px;line-height:1.4;font-weight:800;letter-spacing:1.8px;text-transform:uppercase;color:${accent};">
                      ${safeEyebrow}
                    </p>
                    <h1 style="margin:0;color:#FFFFFF;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;font-size:30px;line-height:1.15;letter-spacing:-0.7px;font-weight:760;">
                      ${safeHeadline}
                    </h1>
                    <p style="margin:18px 0 0;color:#C8D1DE;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;font-size:15px;line-height:1.75;">
                      ${safeBody}
                    </p>
                  </td>
                </tr>
              </table>

              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
                style="background:#FFFFFF;border-radius:0 0 24px 24px;border:1px solid #E1E7EF;border-top:0;">
                <tr>
                  <td style="padding:28px 34px 32px;">

                    ${detailsHtml}

                    ${
                      ctaLabel && ctaUrl
                        ? `
                    <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin-top:${detailsHtml ? "24px" : "0"};">
                      <tr>
                        <td>
                          <a href="${safeCtaUrl}"
                            style="display:inline-block;background:${accent};color:#FFFFFF;text-decoration:none;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;font-size:14px;font-weight:800;padding:14px 22px;border-radius:12px;">
                            ${safeCtaLabel}
                          </a>
                        </td>
                      </tr>
                    </table>`
                        : ""
                    }

                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <tr>
            <td align="center" style="padding:22px 22px 0;">
              <p style="margin:0;color:#7A8797;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;font-size:11px;line-height:1.6;">
                ${footer}
              </p>
              <p style="margin:7px 0 0;color:#A0A9B5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;font-size:10px;">
                Showwork &middot; useshowwork.com
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

function infoBox(label: string, value: string, accent = "#2478FF"): string {
  return `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
      style="margin:0;background:#F6F8FB;border:1px solid #E3E8EF;border-radius:14px;">
      <tr>
        <td style="padding:16px 18px;border-left:3px solid ${accent};">
          <p style="margin:0 0 5px;font-family:Arial,sans-serif;font-size:10px;font-weight:800;letter-spacing:1.1px;text-transform:uppercase;color:#8A96A5;">
            ${escapeHtml(label)}
          </p>
          <p style="margin:0;font-family:Arial,sans-serif;font-size:15px;line-height:1.5;font-weight:700;color:#172033;">
            ${escapeHtml(value)}
          </p>
        </td>
      </tr>
    </table>
  `;
}

function buttonHtml(label: string, url: string, accent = "#2478FF"): string {
  return `
    <a href="${escapeHtml(url)}"
      style="display:inline-block;padding:14px 22px;background:${accent};color:#FFFFFF;text-decoration:none;border-radius:12px;font-family:Arial,sans-serif;font-size:14px;font-weight:800;">
      ${escapeHtml(label)}
    </a>
  `;
}

/** Generates a random 6-digit numeric code, e.g. "042817". */
export function generateOtpCode(): string {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

export async function sendOtpEmail(
  to: string,
  code: string,
  name?: string | null,
) {
  const greeting = firstNameOf(name);

  await sendEmail({
    from: FROM,
    to,
    subject: `${code} is your Showwork verification code`,
    html: emailShell({
      eyebrow: "Verify your email",
      headline: "One last step.",
      body: `
        ${greeting ? `Hi ${escapeHtml(greeting)},` : "Hi there,"}
        <br /><br />
        Enter the verification code below to confirm your email and finish setting up Showwork.
      `,
      detailsHtml: `
        <div style="text-align:center;padding:22px 18px;background:#F7F9FC;border:1px solid #E2E8F0;border-radius:18px;">
          <p style="margin:0 0 8px;font-family:Arial,sans-serif;font-size:10px;font-weight:800;letter-spacing:1.5px;text-transform:uppercase;color:#8A96A5;">Your verification code</p>
          <p style="margin:0;font-family:Arial,sans-serif;font-size:42px;line-height:1.1;letter-spacing:7px;font-weight:800;color:#101828;">${escapeHtml(code)}</p>
          <p style="margin:12px 0 0;font-family:Arial,sans-serif;font-size:12px;color:#667085;">Expires in 10 minutes.</p>
        </div>
      `,
      footer: "If you didn't request this code, you can safely ignore this email.",
    }),
  });
}

/**
 * Sent to the creator whenever a client approves or requests revision
 * on a file. Includes the note when it's a revision request.
 */
export async function sendReviewNotificationEmail({
  to,
  creatorName,
  clientName,
  fileLabel,
  status,
  note,
  dashboardUrl,
}: {
  to: string;
  creatorName?: string | null;
  clientName: string;
  fileLabel: string;
  status: "APPROVED" | "NEEDS_REVISION";
  note?: string | null;
  dashboardUrl: string;
}) {
  const isApproved = status === "APPROVED";

  await sendEmail({
    from: FROM,
    to,
    subject: isApproved
      ? `${clientName} approved a file`
      : `${clientName} requested a revision`,
    html: emailShell({
      eyebrow: isApproved ? "Approved" : "Revision requested",
      headline: isApproved
        ? `${clientName} approved your work.`
        : `${clientName} has feedback for you.`,
      body: `
        Hi ${escapeHtml(firstNameOf(creatorName) ?? "there")},<br /><br />
        ${escapeHtml(clientName)} just ${isApproved ? "approved" : "requested a revision on"} a file in your project.
      `,
      detailsHtml: `
        ${infoBox("File", fileLabel, isApproved ? "#22C55E" : "#F97316")}
        ${
          !isApproved && note
            ? `<div style="margin-top:14px;padding:16px 18px;background:#FFF7ED;border:1px solid #FED7AA;border-radius:14px;">
                <p style="margin:0 0 6px;font-family:Arial,sans-serif;font-size:10px;font-weight:800;letter-spacing:1px;text-transform:uppercase;color:#C2410C;">Client note</p>
                <p style="margin:0;font-family:Arial,sans-serif;font-size:14px;line-height:1.65;color:#7C2D12;">“${escapeHtml(note)}”</p>
              </div>`
            : ""
        }
      `,
      ctaLabel: "Open project",
      ctaUrl: dashboardUrl,
      accent: isApproved ? "#16A34A" : "#F97316",
      footer: `Activity from ${escapeHtml(clientName)} on Showwork.`,
    }),
  });
}

/**
 * Sent to the project owner (and the file's uploader, if different)
 * whenever a client leaves a new timestamped comment on a video.
 */
export async function sendVideoCommentNotificationEmail({
  to,
  creatorName,
  clientName,
  fileLabel,
  note,
  videoTimestampSeconds,
  dashboardUrl,
}: {
  to: string;
  creatorName?: string | null;
  clientName: string;
  fileLabel: string;
  note: string;
  videoTimestampSeconds: number;
  dashboardUrl: string;
}) {
  const total = Math.max(0, Math.round(videoTimestampSeconds));
  const m = Math.floor(total / 60);
  const s = total % 60;
  const formattedTimestamp = `${m}:${String(s).padStart(2, "0")}`;

  await sendEmail({
    from: FROM,
    to,
    subject: `${clientName} commented on ${fileLabel}`,
    html: emailShell({
      eyebrow: "New video comment",
      headline: "A client left a note on the timeline.",
      body: `
        Hi ${escapeHtml(firstNameOf(creatorName) ?? "there")},<br /><br />
        ${escapeHtml(clientName)} left a comment on your video. Jump straight to the moment they were talking about.
      `,
      detailsHtml: `
        ${infoBox("File", fileLabel)}
        <div style="margin-top:14px;padding:18px;background:#EEF5FF;border:1px solid #CFE0FF;border-radius:14px;">
          <p style="margin:0 0 6px;font-family:Arial,sans-serif;font-size:10px;font-weight:800;letter-spacing:1px;text-transform:uppercase;color:#2478FF;">Timestamp</p>
          <p style="margin:0;font-family:Arial,sans-serif;font-size:24px;font-weight:800;color:#172033;">${formattedTimestamp}</p>
          <p style="margin:8px 0 0;font-family:Arial,sans-serif;font-size:14px;line-height:1.6;color:#526173;">“${escapeHtml(note)}”</p>
        </div>
      `,
      ctaLabel: "View comment",
      ctaUrl: dashboardUrl,
      heroImage: true,
      footer: `A new client comment was added to ${escapeHtml(clientName)}'s project.`,
    }),
  });
}

/**
 * Sent to the client once the creator uploads a corrected version.
 */
export async function sendRevisionReadyEmail({
  to,
  clientName,
  publicUrl,
}: {
  to: string;
  clientName: string;
  publicUrl: string;
}) {
  await sendEmail({
    from: FROM,
    to,
    subject: `An update is ready on ${clientName}'s delivery`,
    html: emailShell({
      eyebrow: "Ready for review",
      headline: "Your requested update is ready.",
      body: `
        Hi ${escapeHtml(firstNameOf(clientName) ?? "there")},<br /><br />
        The work you flagged for revision has been updated. Everything is ready for another look.
      `,
      detailsHtml: `
        <div style="padding:18px;background:#F4F9FF;border:1px solid #D9E9FF;border-radius:16px;">
          <p style="margin:0;font-family:Arial,sans-serif;font-size:14px;line-height:1.65;color:#344054;">
            When you're ready, open the delivery and review the latest version. If everything looks right, you're all set.
          </p>
        </div>
      `,
      ctaLabel: "Review the update",
      ctaUrl: publicUrl,
      heroImage: true,
      footer: `Your delivery from ${escapeHtml(clientName)} is ready on Showwork.`,
    }),
  });
}

/**
 * Sent when someone requests a password reset.
 */
export async function sendPasswordResetEmail(
  to: string,
  resetUrl: string,
  name?: string | null,
) {
  await sendEmail({
    from: FROM,
    to,
    subject: "Reset your Showwork password",
    html: emailShell({
      eyebrow: "Account security",
      headline: "Let's get you back in.",
      body: `
        Hi ${escapeHtml(firstNameOf(name) ?? "there")},<br /><br />
        Someone requested a password reset for your Showwork account. If that was you, use the button below to choose a new password.
      `,
      detailsHtml: `
        <div style="padding:16px 18px;background:#F8FAFC;border:1px solid #E2E8F0;border-radius:14px;">
          <p style="margin:0;font-family:Arial,sans-serif;font-size:13px;line-height:1.6;color:#667085;">
            This reset link expires in 30 minutes. If you didn't request it, you don't need to do anything.
          </p>
        </div>
      `,
      ctaLabel: "Reset password",
      ctaUrl: resetUrl,
      accent: "#101828",
      footer: "For your security, your password will not change unless you use the reset link.",
    }),
  });
}

/* -------------------------------------------------------------------------- */
/* COLLABORATION NOTIFICATIONS                                                 */
/* -------------------------------------------------------------------------- */

export async function sendProjectInviteEmail({
  to,
  inviterName,
  projectName,
  acceptUrl,
}: {
  to: string;
  inviterName: string;
  projectName: string;
  acceptUrl: string;
}) {
  await sendEmail({
    from: FROM,
    to,
    subject: `${inviterName} invited you to collaborate on "${projectName}"`,
    html: emailShell({
      eyebrow: "You're invited",
      headline: `${inviterName} wants you in the room.`,
      body: `
        You've been invited to collaborate on <strong style="color:#FFFFFF;">${escapeHtml(projectName)}</strong> on Showwork.
        Bring your work into one place, keep the review moving, and give everyone a clear view of what's happening.
      `,
      detailsHtml: infoBox("Project", projectName),
      ctaLabel: "View invitation",
      ctaUrl: acceptUrl,
      heroImage: true,
      footer: "This invitation expires in 7 days.",
    }),
  });
}

export async function sendCollaboratorAddedEmail({
  to,
  addedByName,
  projectName,
  projectUrl,
}: {
  to: string;
  addedByName: string;
  projectName: string;
  projectUrl: string;
}) {
  await sendEmail({
    from: FROM,
    to,
    subject: `${addedByName} added you to "${projectName}"`,
    html: emailShell({
      eyebrow: "You're on the team",
      headline: "You're officially in.",
      body: `
        ${escapeHtml(addedByName)} added you as a collaborator on <strong style="color:#FFFFFF;">${escapeHtml(projectName)}</strong>.
        Your workspace is ready whenever you are.
      `,
      detailsHtml: infoBox("Project", projectName),
      ctaLabel: "Open project",
      ctaUrl: projectUrl,
      heroImage: true,
    }),
  });
}

export async function sendTaskAssignedEmail({
  to,
  assignedByName,
  taskTitle,
  projectName,
  projectUrl,
}: {
  to: string;
  assignedByName: string;
  taskTitle: string;
  projectName: string;
  projectUrl: string;
}) {
  await sendEmail({
    from: FROM,
    to,
    subject: `New task on "${projectName}": ${taskTitle}`,
    html: emailShell({
      eyebrow: "New task",
      headline: escapeHtml(taskTitle),
      body: `
        ${escapeHtml(assignedByName)} assigned you a task on <strong style="color:#FFFFFF;">${escapeHtml(projectName)}</strong>.
        Pick it up when you're ready and keep the work moving.
      `,
      detailsHtml: infoBox("Project", projectName),
      ctaLabel: "View task",
      ctaUrl: projectUrl,
      heroImage: true,
    }),
  });
}

export async function sendTaskNeedsChangesEmail({
  to,
  reviewerName,
  taskTitle,
  projectName,
  note,
  projectUrl,
}: {
  to: string;
  reviewerName: string;
  taskTitle: string;
  projectName: string;
  note: string | null;
  projectUrl: string;
}) {
  await sendEmail({
    from: FROM,
    to,
    subject: `Changes requested on "${taskTitle}"`,
    html: emailShell({
      eyebrow: "Needs a revision",
      headline: "A small change, then you're clear.",
      body: `
        ${escapeHtml(reviewerName)} reviewed your work on <strong style="color:#FFFFFF;">${escapeHtml(projectName)}</strong>
        and asked for a revision.
      `,
      detailsHtml: `
        ${infoBox("Task", taskTitle, "#F97316")}
        ${
          note
            ? `<div style="margin-top:14px;padding:16px 18px;background:#FFF7ED;border:1px solid #FED7AA;border-radius:14px;">
                <p style="margin:0 0 6px;font-family:Arial,sans-serif;font-size:10px;font-weight:800;letter-spacing:1px;text-transform:uppercase;color:#C2410C;">Review note</p>
                <p style="margin:0;font-family:Arial,sans-serif;font-size:14px;line-height:1.65;color:#7C2D12;">“${escapeHtml(note)}”</p>
              </div>`
            : ""
        }
      `,
      ctaLabel: "View task",
      ctaUrl: projectUrl,
      heroImage: true,
      accent: "#F97316",
    }),
  });
}

export async function sendTaskApprovedEmail({
  to,
  reviewerName,
  taskTitle,
  projectName,
  projectUrl,
}: {
  to: string;
  reviewerName: string;
  taskTitle: string;
  projectName: string;
  projectUrl: string;
}) {
  await sendEmail({
    from: FROM,
    to,
    subject: `"${taskTitle}" was approved`,
    html: emailShell({
      eyebrow: "Approved",
      headline: "That's a wrap on this task.",
      body: `
        ${escapeHtml(reviewerName)} approved your work on <strong style="color:#FFFFFF;">${escapeHtml(projectName)}</strong>.
        Nice work — the next step is ready when you are.
      `,
      detailsHtml: infoBox("Task", taskTitle, "#16A34A"),
      ctaLabel: "View project",
      ctaUrl: projectUrl,
      heroImage: true,
      accent: "#16A34A",
    }),
  });
}

export async function sendNewUploadReadyForReviewEmail({
  to,
  uploaderName,
  taskTitle,
  projectName,
  projectUrl,
}: {
  to: string;
  uploaderName: string;
  taskTitle: string;
  projectName: string;
  projectUrl: string;
}) {
  await sendEmail({
    from: FROM,
    to,
    subject: `${uploaderName} uploaded work on "${projectName}"`,
    html: emailShell({
      eyebrow: "Ready for your review",
      headline: `${uploaderName} finished the work.`,
      body: `
        A new upload is waiting for your review on <strong style="color:#FFFFFF;">${escapeHtml(projectName)}</strong>.
        Approve it or leave a note if anything needs another pass.
      `,
      detailsHtml: infoBox("Task", taskTitle),
      ctaLabel: "Review now",
      ctaUrl: projectUrl,
      heroImage: true,
    }),
  });
}

/* -------------------------------------------------------------------------- */
/* LIFECYCLE                                                                    */
/* -------------------------------------------------------------------------- */

export async function sendWelcomeEmail({
  to,
  name,
}: {
  to: string;
  name: string | null;
}) {
  const firstName = firstNameOf(name);

  await sendEmail({
    from: FROM,
    to,
    subject: "Welcome to Showwork",
    html: emailShell({
      eyebrow: "Welcome to Showwork",
      headline: firstName
        ? `Good to have you here, ${firstName}.`
        : "Good to have you here.",
      body: `
        Showwork helps creators and agencies build portfolios, deliver projects and manage client accounts. Content Workspace brings content, approvals, conversations, leads and analytics together for each client.
        <br /><br />
        Your account is ready. Build a portfolio, create a project delivery or start a client workspace from your dashboard.
      `,
      detailsHtml: `
        <div style="padding:18px;background:#F6F8FB;border:1px solid #E3E8EF;border-radius:16px;">
          <p style="margin:0 0 7px;font-family:Arial,sans-serif;font-size:10px;font-weight:800;letter-spacing:1.1px;text-transform:uppercase;color:#2478FF;">Your Showwork workspace</p>
          <p style="margin:0;font-family:Arial,sans-serif;font-size:15px;line-height:1.6;font-weight:700;color:#172033;">Show your work. Deliver projects. Manage client accounts.</p>
        </div>
      `,
      ctaLabel: "Open Showwork",
      ctaUrl: `${APP_URL}/dashboard`,
      heroImage: true,
      footer: "Welcome to Showwork. We're glad you're here.",
    }),
  });
}

export async function sendPortfolioInviteEmail({
  to,
  name,
}: {
  to: string;
  name: string | null;
}) {
  const firstName = firstNameOf(name);

  await sendEmail({
    from: FROM,
    to,
    subject: "Your portfolio is free — and ready when you are",
    html: emailShell({
      eyebrow: "Portfolio · Free",
      headline: firstName
        ? `${firstName}, make the work easy to believe in.`
        : "Make the work easy to believe in.",
      body: `
        Your portfolio is free on Showwork. Give potential clients one polished place to see what you do, what you've made, and why they should trust you with the next brief.
      `,
      detailsHtml: `
        <div style="padding:18px;background:#F6F8FB;border:1px solid #E3E8EF;border-radius:16px;">
          <p style="margin:0 0 7px;font-family:Arial,sans-serif;font-size:10px;font-weight:800;letter-spacing:1.1px;text-transform:uppercase;color:#2478FF;">A better first impression</p>
          <p style="margin:0;font-family:Arial,sans-serif;font-size:15px;line-height:1.65;color:#344054;">Your work deserves more than a scattered feed or a folder of links.</p>
        </div>
      `,
      ctaLabel: "Build your portfolio",
      ctaUrl: `${APP_URL}/dashboard/portfolio`,
      heroImage: true,
    }),
  });
}

export async function sendProjectManagementIntroEmail({
  to,
  name,
}: {
  to: string;
  name: string | null;
}) {
  const firstName = firstNameOf(name);

  await sendEmail({
    from: FROM,
    to,
    subject: "There's more to the work than the final delivery",
    html: emailShell({
      eyebrow: "Project Delivery · Showwork",
      headline: firstName
        ? `${firstName}, take control before delivery day.`
        : "Take control before delivery day.",
      body: `
        Build the brief, assign the work, keep everyone aligned and give your client a live view of progress — before the final files ever arrive.
        <br /><br />
        It's the difference between simply finishing work and running a professional operation.
      `,
      ctaLabel: "Start a managed project",
      ctaUrl: `${APP_URL}/dashboard/start`,
      heroImage: true,
    }),
  });
}

export async function sendCreativoPromoEmail({
  to,
  name,
}: {
  to: string;
  name: string | null;
}) {
  const firstName = firstNameOf(name);

  await sendEmail({
    from: FROM,
    to,
    subject: "Meet Creativo — the community built around the creative life",
    html: emailShell({
      eyebrow: "Showwork × Creativo",
      headline: firstName
        ? `${firstName}, you don't have to build alone.`
        : "You don't have to build alone.",
      body: `
        Creativo is a free community for creators who are figuring out the business behind the work — pricing, positioning, better clients, visibility, growth and the things nobody teaches you at the beginning.
        <br /><br />
        Showwork helps you run the work. <strong style="color:#FFFFFF;">Creativo helps you grow around it.</strong>
      `,
      ctaLabel: "Join Creativo — it's free",
      ctaUrl: COMMUNITY_URL,
      dualBrand: true,
      heroImage: true,
      accent: "#7C5CFF",
      footer: "Creativo is a free community for creators, presented by Showwork.",
    }),
  });
}

export async function sendDeliverReminderEmail({
  to,
  name,
}: {
  to: string;
  name: string | null;
}) {
  const firstName = firstNameOf(name);

  await sendEmail({
    from: FROM,
    to,
    subject: "Ready to send your next delivery?",
    html: emailShell({
      eyebrow: "Delivery · Whenever you're ready",
      headline: firstName
        ? `${firstName}, got something ready to send?`
        : "Got something ready to send?",
      body: `
        A polished delivery changes how your work feels before the client even opens it.
        <br /><br />
        Put the files in one branded, password-protected experience and give the work the finish it deserves.
      `,
      ctaLabel: "Deliver a project",
      ctaUrl: `${APP_URL}/start`,
      heroImage: true,
    }),
  });
}

export async function sendManagedProjectInviteEmail({
  to,
  inviterName,
  projectName,
  acceptUrl,
}: {
  to: string;
  inviterName: string;
  projectName: string;
  acceptUrl: string;
}) {
  await sendEmail({
    from: FROM,
    to,
    subject: `${inviterName} invited you to work on "${projectName}"`,
    html: emailShell({
      eyebrow: "You're invited",
      headline: `${inviterName} wants you on the project.`,
      body: `
        You've been invited to collaborate on <strong style="color:#FFFFFF;">${escapeHtml(projectName)}</strong> on Showwork.
        If you don't have an account yet, we'll guide you through the setup.
      `,
      detailsHtml: infoBox("Project", projectName),
      ctaLabel: "View invitation",
      ctaUrl: acceptUrl,
      heroImage: true,
      footer: "This invitation expires in 7 days.",
    }),
  });
}

/* -------------------------------------------------------------------------- */
/* CREATIVO                                                                    */
/* -------------------------------------------------------------------------- */

export async function sendWebinarHostApplicationEmail({
  name,
  email,
  category,
  proposedTopic,
  whyThem,
}: {
  name: string;
  email: string;
  category: string;
  proposedTopic: string;
  whyThem: string;
}) {
  await sendEmail({
    from: FROM,
    to: "hello@useshowwork.com",
    replyTo: email,
    subject: `Creativo webinar host application — ${name}`,
    html: emailShell({
      eyebrow: "Showwork × Creativo · Host application",
      headline: `${name} wants to host a Creativo session.`,
      body: "A new creator has submitted an application to host a Creativo webinar. Here are the details.",
      dualBrand: true,
      accent: "#7C5CFF",
      detailsHtml: `
        ${infoBox("Name", name)}
        <div style="height:10px;line-height:10px;">&nbsp;</div>
        ${infoBox("Email", email)}
        <div style="height:10px;line-height:10px;">&nbsp;</div>
        ${infoBox("Category", category)}
        <div style="height:10px;line-height:10px;">&nbsp;</div>
        ${infoBox("Proposed topic", proposedTopic)}
        <div style="height:10px;line-height:10px;">&nbsp;</div>
        ${infoBox("Why them", whyThem)}
      `,
      footer: "Reply directly to this email to respond to the applicant.",
    }),
  });
}

/* -------------------------------------------------------------------------- */
/* PORTFOLIO BILLING                                                           */
/* -------------------------------------------------------------------------- */

export async function sendPortfolioPaymentFailedEmail({
  to,
  name,
  portfolioName,
}: {
  to: string;
  name: string | null;
  portfolioName: string;
}) {
  await sendEmail({
    from: FROM,
    to,
    subject: `Payment failed — "${portfolioName}" is now offline`,
    html: emailShell({
      eyebrow: "Portfolio · Payment issue",
      headline: "Your portfolio needs your attention.",
      body: `
        Hi ${escapeHtml(firstNameOf(name) ?? "there")},<br /><br />
        The monthly payment for <strong style="color:#FFFFFF;">${escapeHtml(portfolioName)}</strong> didn't go through, so the portfolio is currently offline.
        <br /><br />
        Update your payment details and bring it back online.
      `,
      detailsHtml: `
        <div style="padding:16px 18px;background:#FFF7ED;border:1px solid #FED7AA;border-radius:14px;">
          <p style="margin:0;font-family:Arial,sans-serif;font-size:13px;line-height:1.65;color:#7C2D12;">
            Your portfolio content is still there. This is a billing interruption, not a deletion.
          </p>
        </div>
      `,
      ctaLabel: "Update payment details",
      ctaUrl: `${APP_URL}/dashboard/portfolio`,
      accent: "#F97316",
      footer: `Billing notice for ${escapeHtml(portfolioName)}.`,
    }),
  });
}

export async function sendPortfolioOfflineReminderEmail({
  to,
  name,
  portfolioName,
  daysOffline,
}: {
  to: string;
  name: string | null;
  portfolioName: string;
  daysOffline: number;
}) {
  await sendEmail({
    from: FROM,
    to,
    subject: `Reminder: "${portfolioName}" is still offline`,
    html: emailShell({
      eyebrow: "Portfolio · Still offline",
      headline: "Your portfolio is waiting for you.",
      body: `
        Hi ${escapeHtml(firstNameOf(name) ?? "there")},<br /><br />
        <strong style="color:#FFFFFF;">${escapeHtml(portfolioName)}</strong> has been offline for
        ${daysOffline} day${daysOffline === 1 ? "" : "s"} because its recurring payment is still unresolved.
      `,
      detailsHtml: `
        <div style="padding:16px 18px;background:#FFF7ED;border:1px solid #FED7AA;border-radius:14px;">
          <p style="margin:0;font-family:Arial,sans-serif;font-size:13px;line-height:1.65;color:#7C2D12;">
            Update your payment details to bring the client-facing portfolio back online.
          </p>
        </div>
      `,
      ctaLabel: "Bring it back online",
      ctaUrl: `${APP_URL}/dashboard/portfolio`,
      accent: "#F97316",
    }),
  });
}

/* -------------------------------------------------------------------------- */
/* SPOTLIGHT                                                                   */
/* -------------------------------------------------------------------------- */

export async function sendSpotlightSubmissionEmail({
  name,
  email,
  phone,
  whatsappNumber,
  category,
  projectLink,
  description,
  note,
}: {
  name: string;
  email: string;
  phone: string;
  whatsappNumber: string | null;
  category: string;
  projectLink: string;
  description: string;
  note: string | null;
}) {
  await sendEmail({
    from: FROM,
    to: "hello@useshowwork.com",
    replyTo: email,
    subject: `Spotlight submission — ${name} (${category})`,
    html: emailShell({
      eyebrow: "Monthly Spotlight · New submission",
      headline: `${name} submitted work for consideration.`,
      body: "A new Spotlight submission has arrived. Everything you need for the first review is below.",
      detailsHtml: `
        ${infoBox("Name", name)}
        <div style="height:10px;line-height:10px;">&nbsp;</div>
        ${infoBox("Email", email)}
        <div style="height:10px;line-height:10px;">&nbsp;</div>
        ${infoBox("Phone number", phone)}
        <div style="height:10px;line-height:10px;">&nbsp;</div>
        ${whatsappNumber ? `${infoBox("WhatsApp number", whatsappNumber)}<div style="height:10px;line-height:10px;">&nbsp;</div>` : ""}
        ${infoBox("Category", category)}
        <div style="height:10px;line-height:10px;">&nbsp;</div>
        ${infoBox("Project link", projectLink)}
        <div style="height:10px;line-height:10px;">&nbsp;</div>
        ${infoBox("Description", description)}
        ${
          note
            ? `<div style="height:10px;line-height:10px;">&nbsp;</div>${infoBox("Note", note)}`
            : ""
        }
      `,
      footer: "Reply directly to this email to respond to the submitter.",
    }),
  });
}

/* -------------------------------------------------------------------------- */
/* CREATIVO WEBINARS                                                           */
/* -------------------------------------------------------------------------- */

export async function sendWebinarRsvpConfirmationEmail({
  to,
  name,
  topic,
  startsAt,
  venue,
  meetingUrl,
}: {
  to: string;
  name: string;
  topic: string;
  startsAt: Date;
  venue: string | null;
  meetingUrl: string | null;
}) {
  const formattedDate = startsAt.toLocaleString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

  await sendEmail({
    from: FROM,
    to,
    subject: `You're confirmed — ${topic}`,
    html: emailShell({
      eyebrow: "Showwork × Creativo · You're in",
      headline: "Your seat is saved.",
      body: `
        Hi ${escapeHtml(firstNameOf(name) ?? name)},<br /><br />
        You're confirmed for <strong style="color:#FFFFFF;">${escapeHtml(topic)}</strong>.
        Keep this email — your session details are below.
      `,
      dualBrand: true,
      heroImage: true,
      accent: "#7C5CFF",
      detailsHtml: `
        ${infoBox("When", formattedDate, "#7C5CFF")}
        ${
          venue
            ? `<div style="height:10px;line-height:10px;">&nbsp;</div>${infoBox("Where", venue, "#7C5CFF")}`
            : ""
        }
        ${
          meetingUrl
            ? `<div style="margin-top:20px;">${buttonHtml("Join the session", meetingUrl, "#7C5CFF")}</div>`
            : `<div style="margin-top:14px;padding:15px 17px;background:#F5F3FF;border:1px solid #E6E0FF;border-radius:14px;"><p style="margin:0;font-family:Arial,sans-serif;font-size:13px;line-height:1.6;color:#51477A;">We'll send the meeting link closer to the session.</p></div>`
        }
      `,
      footer: "Creativo is a free community for creators, presented by Showwork.",
    }),
  });
}

export async function sendWebinarRsvpNotificationEmail({
  webinarTopic,
  name,
  email,
  whatsappNumber,
}: {
  webinarTopic: string;
  name: string;
  email: string;
  whatsappNumber: string;
}) {
  await sendEmail({
    from: FROM,
    to: "hello@useshowwork.com",
    replyTo: email,
    subject: `New Creativo RSVP — ${webinarTopic}`,
    html: emailShell({
      eyebrow: "Showwork × Creativo · New RSVP",
      headline: `${name} is joining the session.`,
      body: "A new RSVP just came in. The attendee details are ready below.",
      dualBrand: true,
      accent: "#7C5CFF",
      detailsHtml: `
        ${infoBox("Webinar", webinarTopic, "#7C5CFF")}
        <div style="height:10px;line-height:10px;">&nbsp;</div>
        ${infoBox("Name", name, "#7C5CFF")}
        <div style="height:10px;line-height:10px;">&nbsp;</div>
        ${infoBox("Email", email, "#7C5CFF")}
        <div style="height:10px;line-height:10px;">&nbsp;</div>
        ${infoBox("WhatsApp", whatsappNumber, "#7C5CFF")}
      `,
      footer: "Reply directly to this email to reach out to the attendee.",
    }),
  });
}

/* -------------------------------------------------------------------------- */
/* ACCOUNT / ADMIN                                                             */
/* -------------------------------------------------------------------------- */

export async function sendAccountRecoveryEmail({ to }: { to: string }) {
  await sendEmail({
    from: FROM,
    to,
    subject: "We ran into an issue — here's how to get back into your account",
    html: emailShell({
      eyebrow: "Account update",
      headline: "We're sorry. Here's the way back in.",
      body: `
        Hi there,<br /><br />
        We ran into a technical issue while working on infrastructure changes, which affected account data for a number of users, including yours.
        We take responsibility for the disruption.
        <br /><br />
        Your account has been recreated under this same email address. For your security, you'll need to set a new password before signing in again.
      `,
      detailsHtml: `
        <div style="padding:18px;background:#F8FAFC;border:1px solid #E2E8F0;border-radius:16px;">
          <p style="margin:0 0 8px;font-family:Arial,sans-serif;font-size:10px;font-weight:800;letter-spacing:1.1px;text-transform:uppercase;color:#2478FF;">What to do</p>
          <p style="margin:0;font-family:Arial,sans-serif;font-size:14px;line-height:1.7;color:#475467;">
            Go to the login page, choose “Forgot password,” and use this same email address. You'll receive a reset link immediately.
          </p>
        </div>
      `,
      ctaLabel: "Go to login",
      ctaUrl: `${APP_URL}/login`,
      accent: "#101828",
      footer: "If anything looks wrong once you're back in, reply directly to this email and we'll help.",
    }),
  });
}

export async function sendFreeAccessGrantedEmail({ to }: { to: string }) {
  await sendEmail({
    from: FROM,
    to,
    subject: "You've got free access to Showwork",
    html: emailShell({
      eyebrow: "A gift from Showwork",
      headline: "Everything is unlocked.",
      body: `
        You now have full, free access to the Showwork features included in your account — no subscription required.
        <br /><br />
        Go ahead. Put the platform to work.
      `,
      ctaLabel: "Open Showwork",
      ctaUrl: `${APP_URL}/dashboard`,
      heroImage: true,
      accent: "#16A34A",
      footer: "Enjoy the access — and reply if you need anything.",
    }),
  });
}

export async function sendDiscountGrantedEmail({
  to,
  discountPercent,
}: {
  to: string;
  discountPercent: number;
}) {
  await sendEmail({
    from: FROM,
    to,
    subject: `You've got ${discountPercent}% off your next Showwork plan`,
    html: emailShell({
      eyebrow: "A gift from Showwork",
      headline: `${discountPercent}% off. Yours.`,
      body: `
        We've added a <strong style="color:#FFFFFF;">${discountPercent}% discount</strong> to your account.
        It'll apply automatically the next time you start or switch to a paid Showwork plan.
      `,
      detailsHtml: `
        <div style="text-align:center;padding:20px;background:#F0FDF4;border:1px solid #BBF7D0;border-radius:16px;">
          <p style="margin:0;font-family:Arial,sans-serif;font-size:42px;line-height:1;font-weight:850;color:#15803D;">${discountPercent}%</p>
          <p style="margin:8px 0 0;font-family:Arial,sans-serif;font-size:12px;color:#166534;">discount applied to your next paid plan</p>
        </div>
      `,
      ctaLabel: "Open Showwork",
      ctaUrl: `${APP_URL}/dashboard`,
      accent: "#16A34A",
    }),
  });
}

/* -------------------------------------------------------------------------- */
/* CLIENT WORKSPACE / CALENDAR                                                  */
/* -------------------------------------------------------------------------- */

export async function sendCalendarInviteEmail({
  to,
  invitedByName,
  clientName,
  token,
  roleLabel,
  permissions,
}: {
  to: string;
  invitedByName: string;
  clientName: string;
  token: string;
  roleLabel?: string;
  permissions?: readonly string[];
}) {
  const acceptUrl = `${APP_URL}/calendars/invites/${token}`;

  await sendEmail({
    from: FROM,
    to,
    subject: `${invitedByName} invited you to ${clientName}'s client workspace`,
    html: emailShell({
      eyebrow: "Content Workspace · You're invited",
      headline: `${invitedByName} wants you in ${clientName}'s workspace.`,
      body: `
        You've been invited to help create and manage content for <strong style="color:#FFFFFF;">${escapeHtml(clientName)}</strong> on Showwork.
        <br /><br />
        Everything you need for the client stays together — content, feedback, approvals and the people working on it.
      `,
      detailsHtml: `
        ${infoBox("Client workspace", clientName)}
        <div style="margin-top:14px;padding:15px 17px;background:#F4F8FF;border:1px solid #D8E7FF;border-radius:14px;">
          <p style="margin:0;font-family:Arial,sans-serif;font-size:13px;line-height:1.6;color:#344054;">
            Your role: ${escapeHtml(roleLabel || "Creative Contributor")}. You can review your assigned feature access before joining.
          </p>
        </div>
      `,
      ctaLabel: "View invitation",
      ctaUrl: acceptUrl,
      heroImage: true,
      footer: "This invitation expires in 7 days.",
    }),
  });
}

export async function sendCalendarPostReviewedEmail({
  to,
  clientName,
  approved,
  note,
  calendarUrl,
}: {
  to: string;
  clientName: string;
  approved: boolean;
  note: string | null;
  calendarUrl: string;
}) {
  await sendEmail({
    from: FROM,
    to,
    subject: approved
      ? `${clientName} approved a post`
      : `${clientName} requested changes on a post`,
    html: emailShell({
      eyebrow: approved ? "Content approved" : "Changes requested",
      headline: approved
        ? `${clientName} approved the latest content.`
        : `${clientName} has feedback on the latest content.`,
      body: `
        A new client review has landed in the <strong style="color:#FFFFFF;">${escapeHtml(clientName)}</strong> client workspace.
        ${approved ? "The post has been approved." : "Take a look at the note and keep the next revision moving."}
      `,
      detailsHtml: note
        ? `<div style="padding:16px 18px;background:${approved ? "#F0FDF4" : "#FFF7ED"};border:1px solid ${approved ? "#BBF7D0" : "#FED7AA"};border-radius:14px;">
            <p style="margin:0 0 6px;font-family:Arial,sans-serif;font-size:10px;font-weight:800;letter-spacing:1px;text-transform:uppercase;color:${approved ? "#15803D" : "#C2410C"};">Client note</p>
            <p style="margin:0;font-family:Arial,sans-serif;font-size:14px;line-height:1.65;color:${approved ? "#166534" : "#7C2D12"};">“${escapeHtml(note)}”</p>
          </div>`
        : infoBox("Workspace", clientName, approved ? "#16A34A" : "#F97316"),
      ctaLabel: "Open client workspace",
      ctaUrl: calendarUrl,
      heroImage: true,
      accent: approved ? "#16A34A" : "#F97316",
    }),
  });
}

export async function sendCalendarPostResubmittedEmail({
  to,
  clientName,
  clientUrl,
}: {
  to: string;
  clientName: string;
  clientUrl: string;
}) {
  await sendEmail({
    from: FROM,
    to,
    subject: `Updated content is ready for ${clientName} to review`,
    html: emailShell({
      eyebrow: "Ready for review",
      headline: `${clientName} has updated content for you.`,
      body: `The changes you requested have been made. Open your client workspace to review the updated post and approve it or request another revision.`,
      detailsHtml: infoBox("Client workspace", clientName, "#2478FF"),
      ctaLabel: "Review updated content",
      ctaUrl: clientUrl,
      heroImage: true,
      accent: "#2478FF",
    }),
  });
}

export async function sendCalendarPaymentFailedEmail({
  to,
  name,
}: {
  to: string;
  name: string | null;
}) {
  await sendEmail({
    from: FROM,
    to,
    subject: "Payment failed — your Content Workspace is offline",
    html: emailShell({
      eyebrow: "Content Workspace · Payment issue",
      headline: "Your client workspaces need your attention.",
      body: `
        Hi ${escapeHtml(firstNameOf(name) ?? "there")},<br /><br />
        Your recurring Content Workspace payment didn't go through, so the workspaces covered by that subscription are currently offline.
        <br /><br />
        Your content is not deleted. Resolve the billing issue and pick up where you left off.
      `,
      detailsHtml: `
        <div style="padding:17px 18px;background:#FFF7ED;border:1px solid #FED7AA;border-radius:14px;">
          <p style="margin:0;font-family:Arial,sans-serif;font-size:13px;line-height:1.65;color:#7C2D12;">
            If your payment method has expired or been declined, updating it is usually all that's needed.
          </p>
        </div>
      `,
      ctaLabel: "Open billing",
      ctaUrl: `${APP_URL}/dashboard/billing?product=content-workspace#content-workspace-plans`,
      accent: "#F97316",
      footer: "Billing notice from Showwork Content Workspace.",
    }),
  });
}

function calendarSubscribeButton(price: string): string {
  return buttonHtml(`Subscribe — ${price}/month`, `${APP_URL}/dashboard/calendars`);
}

type ContentWorkspacePlan = "CREATOR" | "STUDIO" | "UNLIMITED";

function contentWorkspacePlanLabel(plan: ContentWorkspacePlan): string {
  return CONTENT_WORKSPACE_PLANS[plan].name;
}

function contentWorkspacePlanPrice(plan: ContentWorkspacePlan): string {
  return `₦${CONTENT_WORKSPACE_PLANS[plan].priceNgnMonthly.toLocaleString("en-NG")}`;
}

export async function sendCalendarTrial2DaysLeftEmail({
  to,
  name,
  plan,
}: {
  to: string;
  name: string | null;
  plan: ContentWorkspacePlan;
}) {
  const price = contentWorkspacePlanPrice(plan);
  const planLabel = contentWorkspacePlanLabel(plan);

  await sendEmail({
    from: FROM,
    to,
    subject: "2 days left on your Showwork Content Workspace trial",
    html: emailShell({
      eyebrow: "Content Workspace · 2 days left",
      headline: "Your trial is almost at the finish line.",
      body: `
        Hi ${escapeHtml(firstNameOf(name) ?? "there")},<br /><br />
        You have <strong style="color:#FFFFFF;">2 days left</strong> on your free Content Workspace trial.
        <br /><br />
        Keep your client work moving without interruption by choosing your plan before the trial ends.
      `,
      detailsHtml: `
        <div style="padding:18px;background:#F4F8FF;border:1px solid #D8E7FF;border-radius:16px;">
          <p style="margin:0 0 6px;font-family:Arial,sans-serif;font-size:10px;font-weight:800;letter-spacing:1px;text-transform:uppercase;color:#2478FF;">Your plan</p>
          <p style="margin:0;font-family:Arial,sans-serif;font-size:20px;font-weight:800;color:#172033;">${planLabel} · ${price}/month</p>
        </div>
      `,
      ctaLabel: `Subscribe — ${price}/month`,
      ctaUrl: `${APP_URL}/dashboard/calendars`,
      accent: "#2478FF",
    }),
  });
}

export async function sendCalendarTrialFollowUpEmail({
  to,
  name,
  plan,
}: {
  to: string;
  name: string | null;
  plan: ContentWorkspacePlan;
}) {
  const price = contentWorkspacePlanPrice(plan);
  const planLabel = contentWorkspacePlanLabel(plan);

  await sendEmail({
    from: FROM,
    to,
    subject: "Your Content Workspace trial ends tomorrow",
    html: emailShell({
      eyebrow: "Content Workspace · Tomorrow",
      headline: "Still thinking about it?",
      body: `
        Hi ${escapeHtml(firstNameOf(name) ?? "there")},<br /><br />
        Your free trial ends tomorrow. If you're getting value from keeping your client content, approvals, conversations, leads and analytics in one place, now is a good time to choose your plan.
        <br /><br />
        And if something is holding you back, reply to this email. We'd like to help.
      `,
      detailsHtml: `
        <div style="padding:18px;background:#F6F8FB;border:1px solid #E3E8EF;border-radius:16px;">
          <p style="margin:0 0 6px;font-family:Arial,sans-serif;font-size:10px;font-weight:800;letter-spacing:1px;text-transform:uppercase;color:#2478FF;">Your plan</p>
          <p style="margin:0;font-family:Arial,sans-serif;font-size:20px;font-weight:800;color:#172033;">${planLabel} · ${price}/month</p>
        </div>
      `,
      ctaLabel: `Keep my workspace — ${price}/month`,
      ctaUrl: `${APP_URL}/dashboard/calendars`,
      accent: "#2478FF",
    }),
  });
}

export async function sendCalendarTrialEndsTodayEmail({
  to,
  name,
  plan,
}: {
  to: string;
  name: string | null;
  plan: ContentWorkspacePlan;
}) {
  const price = contentWorkspacePlanPrice(plan);

  await sendEmail({
    from: FROM,
    to,
    subject: "Your Showwork Content Workspace trial ends today",
    html: emailShell({
      eyebrow: "Content Workspace · Ends today",
      headline: "Today is the last day of your trial.",
      body: `
        Hi ${escapeHtml(firstNameOf(name) ?? "there")},<br /><br />
        Your free Content Workspace trial ends today.
        <br /><br />
        Subscribe now and keep your client work accessible without interruption.
      `,
      detailsHtml: `
        <div style="padding:18px;background:#FFF7ED;border:1px solid #FED7AA;border-radius:16px;">
          <p style="margin:0 0 6px;font-family:Arial,sans-serif;font-size:10px;font-weight:800;letter-spacing:1px;text-transform:uppercase;color:#C2410C;">Starting price</p>
          <p style="margin:0;font-family:Arial,sans-serif;font-size:20px;font-weight:800;color:#172033;">${price}/month</p>
        </div>
      `,
      ctaLabel: `Subscribe — ${price}/month`,
      ctaUrl: `${APP_URL}/dashboard/calendars`,
      accent: "#F97316",
    }),
  });
}

export async function sendCalendarTrialEndedEmail({
  to,
  name,
  plan,
}: {
  to: string;
  name: string | null;
  plan: ContentWorkspacePlan;
}) {
  const price = contentWorkspacePlanPrice(plan);
  const planLabel = contentWorkspacePlanLabel(plan);

  await sendEmail({
    from: FROM,
    to,
    subject: "Your Showwork Content Workspace trial has ended",
    html: emailShell({
      eyebrow: "Content Workspace · Trial ended",
      headline: "Your work is still here. Your trial has simply ended.",
      body: `
        Hi ${escapeHtml(firstNameOf(name) ?? "there")},<br /><br />
        Your free trial has ended and your Content Workspace access is currently locked until you subscribe.
        <br /><br />
        Your content hasn't gone anywhere. Subscribe and everything can continue from where you left off.
      `,
      detailsHtml: `
        <div style="padding:18px;background:#F8FAFC;border:1px solid #E2E8F0;border-radius:16px;">
          <p style="margin:0 0 6px;font-family:Arial,sans-serif;font-size:10px;font-weight:800;letter-spacing:1px;text-transform:uppercase;color:#667085;">Your plan</p>
          <p style="margin:0;font-family:Arial,sans-serif;font-size:20px;font-weight:800;color:#172033;">${planLabel} · ${price}/month</p>
        </div>
      `,
      ctaLabel: `Reactivate — ${price}/month`,
      ctaUrl: `${APP_URL}/dashboard/calendars`,
      accent: "#F97316",
    }),
  });
}

/* -------------------------------------------------------------------------- */
/* PARTNER PROGRAM                                                             */
/* -------------------------------------------------------------------------- */

export async function sendPartnerReferralSignupEmail({
  to,
  partnerName,
  referredCreatorName,
}: {
  to: string;
  partnerName: string | null;
  referredCreatorName: string | null;
}) {
  const partnerFirstName = firstNameOf(partnerName);
  const creatorDisplayName =
    referredCreatorName?.trim() || "A new creator";

  await sendEmail({
    from: FROM,
    to,
    subject: "You have a new Showwork referral",
    html: emailShell({
      eyebrow: "Partner Program · New referral",
      headline: "Someone joined through your link.",
      body: `
        ${
          partnerFirstName
            ? `Hi ${escapeHtml(partnerFirstName)},`
            : "Hi there,"
        }
        <br /><br />
        Someone just created a Showwork account using your referral link.
        Their account is now connected to your Partner Program profile.
      `,
      detailsHtml: `
        ${infoBox("New referral", creatorDisplayName)}
        <div style="height:10px;line-height:10px;">&nbsp;</div>
        <div style="padding:16px 18px;background:#F4F8FF;border:1px solid #D8E7FF;border-radius:14px;">
          <p style="margin:0;font-family:Arial,sans-serif;font-size:13px;line-height:1.65;color:#344054;">
            Their referral is currently pending. If they make a qualifying Showwork payment,
            you'll earn your partner commission according to the Partner Program terms.
          </p>
        </div>
      `,
      ctaLabel: "View Partner Dashboard",
      ctaUrl: `${APP_URL}/dashboard/partners`,
      heroImage: true,
      accent: "#2478FF",
      footer:
        "You can view your referrals and commission history from your Partner Dashboard.",
    }),
  });
}

export async function sendPartnerCommissionEarnedEmail({
  to,
  partnerName,
  paymentAmountNgn,
  commissionAmountNgn,
  paymentType,
}: {
  to: string;
  partnerName: string | null;
  paymentAmountNgn: number;
  commissionAmountNgn: number;
  paymentType: string;
}) {
  const partnerFirstName = firstNameOf(partnerName);

  const formatNgn = (amount: number) =>
    new Intl.NumberFormat("en-NG", {
      style: "currency",
      currency: "NGN",
      maximumFractionDigits: 0,
    }).format(amount);

  const paymentLabel =
    paymentType === "CONTENT_WORKSPACE_SUBSCRIPTION_INITIAL"
      ? "Content Workspace subscription"
      : paymentType === "CONTENT_WORKSPACE_SUBSCRIPTION_RENEWAL"
        ? "Content Workspace renewal"
        : paymentType === "SUBSCRIPTION_INITIAL"
          ? "Showwork subscription"
          : paymentType === "SUBSCRIPTION_RENEWAL"
            ? "Showwork subscription renewal"
            : "Qualifying Showwork payment";

  await sendEmail({
    from: FROM,
    to,
    subject: `You earned ${formatNgn(commissionAmountNgn)} from a referral`,
    html: emailShell({
      eyebrow: "Partner Program · Commission earned",
      headline: "Your referral just generated a commission.",
      body: `
        ${
          partnerFirstName
            ? `Hi ${escapeHtml(partnerFirstName)},`
            : "Hi there,"
        }
        <br /><br />
        A creator you referred just made a qualifying payment on Showwork.
        Your commission has been recorded in your Partner Dashboard.
      `,
      detailsHtml: `
        ${infoBox("Commission earned", formatNgn(commissionAmountNgn), "#16A34A")}
        <div style="height:10px;line-height:10px;">&nbsp;</div>
        ${infoBox("Customer payment", formatNgn(paymentAmountNgn))}
        <div style="height:10px;line-height:10px;">&nbsp;</div>
        ${infoBox("Payment", paymentLabel)}
        <div style="margin-top:14px;padding:15px 17px;background:#F0FDF4;border:1px solid #BBF7D0;border-radius:14px;">
          <p style="margin:0;font-family:Arial,sans-serif;font-size:13px;line-height:1.65;color:#166534;">
            Your commission is now recorded and will follow the normal review and payout process.
          </p>
        </div>
      `,
      ctaLabel: "View Commission",
      ctaUrl: `${APP_URL}/dashboard/partners`,
      heroImage: true,
      accent: "#16A34A",
      footer:
        "Your Partner Dashboard always shows the current status of your commissions.",
    }),
  });
}

export async function sendPartnerPayoutPaidEmail({
  to,
  partnerName,
  amountNgn,
  payoutReference,
}: {
  to: string;
  partnerName: string | null;
  amountNgn: number;
  payoutReference: string;
}) {
  const partnerFirstName = firstNameOf(partnerName);

  const formatNgn = (amount: number) =>
    new Intl.NumberFormat("en-NG", {
      style: "currency",
      currency: "NGN",
      maximumFractionDigits: 0,
    }).format(amount);

  await sendEmail({
    from: FROM,
    to,
    subject: `Your ${formatNgn(amountNgn)} partner payout has been sent`,
    html: emailShell({
      eyebrow: "Partner Program · Payout sent",
      headline: "Your payout has been sent.",
      body: `
        ${
          partnerFirstName
            ? `Hi ${escapeHtml(partnerFirstName)},`
            : "Hi there,"
        }
        <br /><br />
        Your approved Partner Program payout has been marked as paid.
        The payment details are below for your records.
      `,
      detailsHtml: `
        ${infoBox("Amount paid", formatNgn(amountNgn), "#16A34A")}
        <div style="height:10px;line-height:10px;">&nbsp;</div>
        ${infoBox("Payment reference", payoutReference)}
        <div style="margin-top:14px;padding:15px 17px;background:#F0FDF4;border:1px solid #BBF7D0;border-radius:14px;">
          <p style="margin:0;font-family:Arial,sans-serif;font-size:13px;line-height:1.65;color:#166534;">
            Keep this reference for your records. Your Partner Dashboard has also been updated.
          </p>
        </div>
      `,
      ctaLabel: "View Partner Dashboard",
      ctaUrl: `${APP_URL}/dashboard/partners`,
      heroImage: true,
      accent: "#16A34A",
      footer:
        "Thank you for growing Showwork with us.",
    }),
  });
}
export async function sendPartnerApplicationReceivedEmail({
  to,
  name,
}: {
  to: string;
  name: string | null;
}) {
  const firstName = firstNameOf(name);

  await sendEmail({
    from: FROM,
    to,
    subject: "Your Showwork Partner Program application is in",
    html: emailShell({
      eyebrow: "Partner Program · Application received",
      headline: "We've received your application.",
      body: `
        Hi ${escapeHtml(firstName ?? "there")},<br /><br />
        Thanks for your interest in becoming a Showwork Partner.
        We've received your application and our team will review it shortly.
        <br /><br />
        If your application is approved, we'll send you everything you need to get started.
      `,
      detailsHtml: `
        <div style="padding:18px;background:#F4F8FF;border:1px solid #D8E7FF;border-radius:16px;">
          <p style="margin:0 0 7px;font-family:Arial,sans-serif;font-size:10px;font-weight:800;letter-spacing:1.1px;text-transform:uppercase;color:#2478FF;">
            What happens next
          </p>
          <p style="margin:0;font-family:Arial,sans-serif;font-size:14px;line-height:1.7;color:#344054;">
            Our team will review your application. You'll receive another email once a decision has been made.
          </p>
        </div>
      `,
      ctaLabel: "Open Showwork",
      ctaUrl: `${APP_URL}/dashboard`,
      accent: "#2478FF",
      footer:
        "Thanks for your interest in the Showwork Partner Program.",
    }),
  });
}


export async function sendPartnerApplicationNotificationEmail({
  name,
  email,
}: {
  name: string;
  email: string;
}) {
  await sendEmail({
    from: FROM,
    to: "hello@useshowwork.com",
    replyTo: email,
    subject: `New Showwork Partner Program application — ${name}`,
    html: emailShell({
      eyebrow: "Partner Program · New application",
      headline: `${name} wants to become a Showwork Partner.`,
      body:
        "A creator has submitted an application to join the Showwork Partner Program. Review their account and decide whether to activate their partner access.",
      detailsHtml: `
        ${infoBox("Applicant", name)}
        <div style="height:10px;line-height:10px;">&nbsp;</div>
        ${infoBox("Email", email)}
        <div style="height:10px;line-height:10px;">&nbsp;</div>
        <div style="padding:16px 18px;background:#F4F8FF;border:1px solid #D8E7FF;border-radius:14px;">
          <p style="margin:0;font-family:Arial,sans-serif;font-size:13px;line-height:1.65;color:#344054;">
            The application is now waiting for review in the Showwork Admin Partner Program dashboard.
          </p>
        </div>
      `,
      ctaLabel: "Review application",
      ctaUrl: `${APP_URL}/admin/partners`,
      accent: "#2478FF",
      footer:
        "Reply directly to this email to contact the applicant.",
    }),
  });
}


export async function sendPartnerApplicationApprovedEmail({
  to,
  name,
}: {
  to: string;
  name: string | null;
}) {
  const firstName = firstNameOf(name);

  await sendEmail({
    from: FROM,
    to,
    subject: "Your Showwork Partner Program application was approved 🎉",
    html: emailShell({
      eyebrow: "Partner Program · Approved",
      headline: "You're officially a Showwork Partner.",
      body: `
        Hi ${escapeHtml(firstName ?? "there")},<br /><br />
        Your application to join the Showwork Partner Program has been approved.
        Welcome to the program.
        <br /><br />
        We've also added your complimentary access and prepared your partner onboarding details below.
      `,
      detailsHtml: `
        <div style="padding:20px;background:#F0FDF4;border:1px solid #BBF7D0;border-radius:16px;">
          <p style="margin:0 0 8px;font-family:Arial,sans-serif;font-size:10px;font-weight:800;letter-spacing:1.1px;text-transform:uppercase;color:#15803D;">
            You're in
          </p>
          <p style="margin:0;font-family:Arial,sans-serif;font-size:15px;line-height:1.7;color:#166534;">
            Your Partner Dashboard is now available and your partner benefits are active.
          </p>
        </div>
      `,
      ctaLabel: "Open Partner Dashboard",
      ctaUrl: `${APP_URL}/dashboard/partners`,
      heroImage: true,
      accent: "#16A34A",
      footer:
        "Welcome to the Showwork Partner Program.",
    }),
  });
}


export async function sendPartnerApplicationDeclinedEmail({
  to,
  name,
}: {
  to: string;
  name: string | null;
}) {
  const firstName = firstNameOf(name);

  await sendEmail({
    from: FROM,
    to,
    subject: "Update on your Showwork Partner Program application",
    html: emailShell({
      eyebrow: "Partner Program · Application update",
      headline: "We've reviewed your application.",
      body: `
        Hi ${escapeHtml(firstName ?? "there")},<br /><br />
        Thank you for your interest in the Showwork Partner Program.
        <br /><br />
        After reviewing your application, we're unable to approve your Partner Program access at this time.
        We appreciate you taking the time to apply and you're welcome to continue using Showwork as normal.
      `,
      detailsHtml: `
        <div style="padding:18px;background:#F8FAFC;border:1px solid #E2E8F0;border-radius:16px;">
          <p style="margin:0;font-family:Arial,sans-serif;font-size:13px;line-height:1.7;color:#475467;">
            If you believe there's additional information our team should consider, you can reply directly to this email.
          </p>
        </div>
      `,
      ctaLabel: "Open Showwork",
      ctaUrl: `${APP_URL}/dashboard`,
      accent: "#667085",
      footer:
        "Thank you for your interest in partnering with Showwork.",
    }),
  });
}


export async function sendPartnerWelcomeEmail({
  to,
  name,
  partnerManagerName,
  partnerManagerEmail,
}: {
  to: string;
  name: string | null;
  partnerManagerName: string;
  partnerManagerEmail: string;
}) {
  const firstName = firstNameOf(name);

  await sendEmail({
    from: FROM,
    to,
    subject: "Welcome to the Showwork Partner Program 🎉",
    html: emailShell({
      eyebrow: "Showwork Partner Program",
      headline: "Welcome to the partnership.",
      body: `
        Hi ${escapeHtml(firstName ?? "there")},<br /><br />

        We're excited to officially welcome you to the Showwork Partner Program.
        <br /><br />

        Your partner access is now active. You can find your unique referral link anytime from your Partner Dashboard and start sharing Showwork with creators and businesses in your network.
        <br /><br />

        Here's what your partnership includes:
      `,
      detailsHtml: `
        <div style="padding:20px;background:#F4F8FF;border:1px solid #D8E7FF;border-radius:16px;">
          <p style="margin:0 0 12px;font-family:Arial,sans-serif;font-size:10px;font-weight:800;letter-spacing:1.1px;text-transform:uppercase;color:#2478FF;">
            Your partner benefits
          </p>

          <p style="margin:0 0 11px;font-family:Arial,sans-serif;font-size:14px;line-height:1.7;color:#344054;">
            <strong>10% commission</strong> on qualifying payments made by each customer you refer.
          </p>

          <p style="margin:0 0 11px;font-family:Arial,sans-serif;font-size:14px;line-height:1.7;color:#344054;">
            <strong>12-month commission window</strong> for each referred customer, beginning with their first qualifying payment.
          </p>

          <p style="margin:0 0 11px;font-family:Arial,sans-serif;font-size:14px;line-height:1.7;color:#344054;">
            <strong>₦5,000 minimum payout</strong> before you can request a payout.
          </p>

          <p style="margin:0 0 11px;font-family:Arial,sans-serif;font-size:14px;line-height:1.7;color:#344054;">
            <strong>1 month complimentary Content Workspace Studio access</strong> has been added to your account.
          </p>

          <p style="margin:0;font-family:Arial,sans-serif;font-size:14px;line-height:1.7;color:#344054;">
            <strong>More qualifying customers can unlock additional complimentary months</strong>, up to 12 additional months.
          </p>
        </div>

        <div style="height:14px;line-height:14px;">&nbsp;</div>

        ${infoBox(
          "Your referral link",
          "Available from your Partner Dashboard"
        )}

        <div style="height:14px;line-height:14px;">&nbsp;</div>

        ${infoBox(
          "Your Partner Manager",
          `${partnerManagerName} · ${partnerManagerEmail}`
        )}

        <div style="margin-top:18px;padding:16px 18px;background:#F8FAFC;border:1px solid #E2E8F0;border-radius:14px;">
          <p style="margin:0;font-family:Arial,sans-serif;font-size:13px;line-height:1.7;color:#475467;">
            Your Partnership Agreement is attached to this email for your records.
            Please review it carefully and keep a copy for your records.
          </p>
        </div>
      `,
      ctaLabel: "Open Partner Dashboard",
      ctaUrl: `${APP_URL}/dashboard/partners`,
      heroImage: true,
      accent: "#2478FF",
      footer:
        "We're looking forward to growing with you. Reply to this email if you need anything.",
    }),
       attachments: [
  {
    filename: "Showwork_Partner_Program_Agreement.pdf",
    path: `${APP_URL}/pdfs/Showwork_Partner_Program_Agreement.pdf`,
  },
],
  });
}


export type BillingBenefitEmail = {
  to: string; name: string | null; title: string; event: "GRANTED" | "STOPPED";
  product: string; deliveryTier: string | null; workspacePlan: string | null;
  percent: number; durationMonths: number; billingCycle: string | null;
  availableUntil: string | null; endsAt: string | null;
};
export async function sendBillingBenefitEmail(input: BillingBenefitEmail, idempotencyKey: string) {
  const stopped = input.event === "STOPPED";
  const free = input.percent === 100;
  const deliveryNames: Record<string,string> = { STARTER: "Starter", GROWTH: "Growth", UNLIMITED: "Unlimited" };
  const date = (value: string) => new Date(value).toLocaleDateString("en-GB", { timeZone: "Africa/Lagos", day: "numeric", month: "long", year: "numeric" });
  const products = [
    ...(input.product !== "CONTENT_WORKSPACE" ? [`Project Delivery · ${input.deliveryTier ? deliveryNames[input.deliveryTier] : "all eligible paid plans"}`] : []),
    ...(input.product !== "DELIVERY" ? [`Content Workspace · ${input.workspacePlan ? CONTENT_WORKSPACE_PLANS[input.workspacePlan as keyof typeof CONTENT_WORKSPACE_PLANS].name : "all eligible paid plans"}`] : []),
  ];
  const terms = stopped
    ? (free ? "This complimentary grant has ended. Any other active benefits and paid subscriptions remain available according to their terms." : "This offer is no longer available for new activation. Discounts already activated keep their agreed terms.")
    : free ? `Your complimentary access is active now${input.endsAt ? ` until ${date(input.endsAt)}` : ""}. Existing paid subscriptions continue to renew unless you cancel them separately in billing.`
    : `You have ${input.percent}% off eligible subscriptions for ${input.durationMonths} billing months. Activate through checkout; the benefit starts with your first successful payment. Your current subscription price stays the same until activation. After the discounted payments, renewal returns to the standard price shown at checkout. Offers do not stack, and switching plans does not restart an activated offer.`;
  const result = await sendEmail({ from: FROM, to: input.to,
    subject: stopped ? `Your Showwork ${free ? "complimentary access" : "discount offer"} has ended` : free ? "Complimentary Showwork access has been added to your account" : `You have a ${input.percent}% Showwork discount offer`,
    html: emailShell({ eyebrow: "Your billing benefits", headline: stopped ? "Your benefit has been updated." : free ? "Your complimentary access is ready." : `${input.percent}% off, available to you.`,
      body: `Hi ${escapeHtml(firstNameOf(input.name) ?? "there")},<br /><br />${escapeHtml(terms)}`,
      detailsHtml: `${infoBox("Offer", input.title)}${products.map(p => infoBox("Included product / plan", p)).join("")}${!stopped ? infoBox("Duration", `${input.durationMonths} month(s)${!free ? ` · ${input.billingCycle === "ANNUAL" ? "Annual billing" : input.billingCycle === "MONTHLY" ? "Monthly billing" : "Eligible monthly / annual billing"}` : ""}`) : ""}${!stopped && !free && input.availableUntil ? infoBox("Activate by", date(input.availableUntil)) : ""}`,
      ctaLabel: "View your billing benefits", ctaUrl: `${APP_URL}/dashboard/billing`, accent: "#2478FF",
      footer: "Your dashboard shows your current benefits and renewal terms. Reply if you need help.",
    }),
  }, idempotencyKey);
  return result?.id ?? null;
}

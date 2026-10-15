import bcrypt from "bcryptjs";
import { NextResponse } from "next/server";
import jwt from "jsonwebtoken";
import { cookies } from "next/headers";
import { db } from "@/lib/db";

const JWT_SECRET = process.env.JWT_SECRET!;
const SESSION_COOKIE = "spotlite_session";

// ── Password hashing (for creator accounts AND project passwords) ──
export async function hashPassword(plain: string) {
  return bcrypt.hash(plain, 10);
}
export async function verifyPassword(plain: string, hash: string) {
  return bcrypt.compare(plain, hash);
}

// ── Session management for creators (dashboard login) ──
/** Receipt-only verification for a former principal. Does not authorize access
 * to an account, workspace or publishing operation; caller must bind a durable
 * previously committed receipt and verify the original password confirmation. */
export function verifyCreatorSessionClaims(token:string):{creatorId:string}|null {
  try {const payload=jwt.verify(token,JWT_SECRET) as {creatorId?:unknown;exp?:unknown};return typeof payload.creatorId==='string'&&typeof payload.exp==='number'&&payload.exp*1000>Date.now()?{creatorId:payload.creatorId}:null;}catch{return null;}
}
export function createSessionToken(creatorId: string) {
  return jwt.sign({ creatorId }, JWT_SECRET, { expiresIn: "30d" });
}

// Sets the cookie directly on the actual NextResponse being returned,
// rather than via cookies().set() from next/headers. That approach
// relies on Next.js implicitly attaching the mutation to the outgoing
// response through internal request-context tracking — reliable on
// Vercel's own runtime, but a known source of inconsistency on other
// deployment platforms (including Netlify's Next.js adapter), since
// that auto-attach behavior isn't something every runtime replicates
// identically. Setting it directly on the response object has no
// such dependency and works the same regardless of platform.
export function setSessionCookie(response: NextResponse, token: string) {
  response.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 30, // 30 days
  });
}

export function clearSessionCookie(response: NextResponse) {
  response.cookies.delete(SESSION_COOKIE);
}

/**
 * Reads the session cookie and returns the logged-in Creator, or null.
 * Use this at the top of any server component/route that needs auth.
 */
export async function getCurrentCreator() {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE)?.value;
  if (!token) return null;

  try {
    const payload = jwt.verify(token, JWT_SECRET) as { creatorId: string };
    const creator = await db.creator.findUnique({
      where: { id: payload.creatorId },
    });
    return creator;
  } catch {
    return null; // invalid/expired token
  }
}

// ── "Unlock" persistence for viewers on the public delivery page ──
// Separate from creator sessions above. One signed cookie per project,
// set the moment a viewer successfully enters the password, so a
// refresh or return visit doesn't make them re-enter the email + code
// every single time. Cookie name is scoped per-project (viewer_{id}),
// so unlocking one project never grants access to another.
//
// Embeds name alongside email — without it, a viewer's name only ever
// lived in that one page load's React state, and vanished on any
// refresh, silently falling back to "Unnamed viewer" on their next
// review even though they'd already told the gate their real name.

export function createViewerToken(projectId: string, email: string, name: string | null) {
  return jwt.sign({ projectId, email, name }, JWT_SECRET, { expiresIn: "30d" });
}

/** Verifies a viewer token actually belongs to this specific project. */
export function verifyViewerToken(
  token: string,
  projectId: string
): { email: string; name: string | null } | null {
  try {
    const payload = jwt.verify(token, JWT_SECRET) as {
      projectId: string;
      email: string;
      name?: string | null;
    };
    if (payload.projectId !== projectId) return null;
    return { email: payload.email, name: payload.name ?? null };
  } catch {
    return null;
  }
}

/** Same viewer JWT authority as verifyViewerToken, retaining its expiry for a
 * bounded transactional eligibility witness. No creator permission is implied. */
export function verifyViewerTokenClaims(token:string,projectId:string):{email:string;name:string|null;expiresAt:Date}|null {
 try {const payload=jwt.verify(token,JWT_SECRET) as {projectId:string;email:string;name?:string|null;exp?:number};
  if(payload.projectId!==projectId||typeof payload.email!=='string'||!payload.exp)return null;
  return {email:payload.email,name:payload.name??null,expiresAt:new Date(payload.exp*1000)};
 }catch{return null;}
}

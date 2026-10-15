import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

const MAX_PAGE_BYTES = 1_500_000;
const MAX_PAGES = 5;
const MAX_TEXT_CHARS = 40_000;

function isPublicIp(address: string) {
  const version = isIP(address);
  if (version === 4) {
    const octets = address.split(".").map(Number);
    const [a, b, c] = octets;
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && (b === 168 || (b === 0 && c === 0) || (b === 0 && c === 2))) return false;
    if (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) return false;
    if (a === 203 && b === 0 && c === 113) return false;
    return true;
  }
  if (version === 6) {
    const normalized = address.toLowerCase().split("%")[0];
    // Reject local, unspecified, multicast, unique-local, link-local, and
    // IPv4-mapped forms. Public IPv6 addresses remain supported.
    if (normalized === "::" || normalized === "::1" || normalized.startsWith("::ffff:")) return false;
    if (normalized.startsWith("2001:db8:")) return false;
    if (/^(fc|fd|fe[89ab]|ff)/.test(normalized)) return false;
    return true;
  }
  return false;
}

async function assertPublicWebsiteUrl(url: URL) {
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("Enter a website address starting with https:// or http://.");
  if (url.username || url.password) throw new Error("Website addresses cannot contain a username or password.");
  if (url.port && url.port !== "80" && url.port !== "443") throw new Error("Only standard website ports are supported.");
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
    throw new Error("That website address is not publicly accessible.");
  }
  const literalVersion = isIP(host);
  const addresses = literalVersion ? [{ address: host }] : await lookup(host, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(({ address }) => !isPublicIp(address))) {
    throw new Error("That website address does not resolve to a public website.");
  }
}

function decodeHtml(value: string) {
  return value
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#(\d+);/g, (_match, code: string) => {
      const point = Number(code);
      return point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : " ";
    })
    .replace(/&#x([\da-f]+);/gi, (_match, code: string) => {
      const point = Number.parseInt(code, 16);
      return point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : " ";
    });
}

function htmlText(html: string) {
  const title = decodeHtml(html.match(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i)?.[1] ?? "").replace(/<[^>]+>/g, " ").trim();
  const main = html.match(/<(main|article)\b[^>]*>([\s\S]*?)<\/\1\s*>/i)?.[2] ?? html;
  const body = main
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|svg|noscript|nav|footer|header|form|iframe)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<br\s*\/?>|<\/(?:p|div|li|h[1-6]|section|article|tr)\s*>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
  return { title, text: decodeHtml(body).replace(/[\t\r ]+/g, " ").replace(/\n\s*/g, "\n").trim() };
}

async function readLimited(response: Response) {
  const declaredLength = Number(response.headers.get("content-length") ?? 0);
  if (declaredLength > MAX_PAGE_BYTES) throw new Error("A page on that website is too large to read.");
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_PAGE_BYTES) {
      await reader.cancel();
      throw new Error("A page on that website is too large to read.");
    }
    chunks.push(value);
  }
  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { combined.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(combined);
}

async function fetchHtml(startUrl: URL) {
  let current = new URL(startUrl);
  for (let redirects = 0; redirects <= 4; redirects++) {
    await assertPublicWebsiteUrl(current);
    let response: Response;
    try {
      response = await fetch(current, {
        cache: "no-store",
        redirect: "manual",
        signal: AbortSignal.timeout(7000),
        headers: { "user-agent": "ShowworkBusinessKnowledge/1.0", accept: "text/html,application/xhtml+xml" },
      });
    } catch (error) {
      if (error instanceof Error && error.name === "TimeoutError") throw new Error("That website took too long to respond. Try again shortly.");
      throw error;
    }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      if (!location || redirects === 4) throw new Error("The website redirected too many times.");
      current = new URL(location, current);
      continue;
    }
    if (!response.ok) throw new Error(`A website page returned HTTP ${response.status}.`);
    const contentType = response.headers.get("content-type") ?? "";
    if (!/text\/html|application\/xhtml\+xml/i.test(contentType)) throw new Error("That website page is not HTML content.");
    return { url: current, html: await readLimited(response) };
  }
  throw new Error("Could not open that website.");
}

/** Reads a small set of useful same-site pages without following external links. */
export async function extractWebsiteKnowledge(input: string) {
  let startUrl: URL;
  try { startUrl = new URL(input.trim().includes("://") ? input.trim() : `https://${input.trim()}`); }
  catch { throw new Error("Enter a valid website address."); }
  if (startUrl.search || startUrl.hash) { startUrl.search = ""; startUrl.hash = ""; }
  await assertPublicWebsiteUrl(startUrl);

  const first = await fetchHtml(startUrl);
  const firstPage = htmlText(first.html);
  const origin = first.url.origin;
  const links = [...first.html.matchAll(/<a\b[^>]*href\s*=\s*(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a\s*>/gi)]
    .map((match) => {
      try {
        const url = new URL(decodeHtml(match[2]).trim(), first.url);
        const label = decodeHtml(match[3].replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
        return { url, label };
      } catch { return null; }
    })
    .filter((link): link is { url: URL; label: string } => !!link && link.url.origin === origin && ["http:", "https:"].includes(link.url.protocol))
    .filter(({ url }) => !/\.(?:pdf|jpe?g|png|gif|svg|webp|mp4|zip|css|js)(?:$|\?)/i.test(url.pathname))
    .filter(({ url, label }) => /about|service|product|solution|pricing|contact|company|story|menu|shop|offer/i.test(`${url.pathname} ${label}`));
  const selected = [...new Map(links.map(({ url }) => { url.hash = ""; return [url.href, url]; })).values()].slice(0, MAX_PAGES - 1);
  const pages = await Promise.all(selected.map(async (url) => {
    try { const page = await fetchHtml(url); return { url: page.url, ...htmlText(page.html) }; }
    catch { return null; }
  }));
  const pageTexts = [{ url: first.url, ...firstPage }, ...pages.filter((page): page is NonNullable<typeof page> => page !== null)];
  const content = pageTexts.map((page) => `Page: ${page.title || page.url.pathname || page.url.hostname}\nURL: ${page.url.href}\n${page.text}`).join("\n\n").slice(0, MAX_TEXT_CHARS);
  if (content.replace(/Page:.*\nURL:.*\n/g, "").trim().length < 100) throw new Error("I couldn't find enough readable text on that website. Try another public page or upload a document instead.");
  return { url: first.url.href, name: first.url.hostname, pageCount: pageTexts.length, text: content };
}

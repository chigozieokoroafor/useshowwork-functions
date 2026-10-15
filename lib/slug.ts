import { db } from "@/lib/db";

function slugify(input: string) {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Turns a client name into a URL-safe, unique slug.
 * e.g. "Showwork" -> "Showwork", or "Showwork-2" if taken.
 */
export async function generateUniqueSlug(clientName: string) {
  const base = slugify(clientName) || "project";
  let slug = base;
  let counter = 2;

  while (await db.project.findUnique({ where: { slug } })) {
    slug = `${base}-${counter}`;
    counter++;
  }
  return slug;
}

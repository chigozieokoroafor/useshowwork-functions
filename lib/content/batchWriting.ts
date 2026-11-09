/** Keep long-form scripts from turning a whole calendar into one oversized model call. */
export async function writeContentBatches(
  call: (request: { instructions: string; input: string; maxOutputTokens: number; jsonSchema: { name: string; schema: Record<string, unknown> } }) => Promise<string>,
  request: { instructions: string; input: string; jsonSchema: { name: string; schema: Record<string, unknown> } },
  identities: { contentUnit: number; platform: string }[],
  options: { concurrency?: number; onBatch?: (posts: unknown[], completed: number, total: number) => Promise<void> | void } = {},
) {
  const batches = Array.from({ length: Math.ceil(identities.length / 3) }, (_, i) => identities.slice(i * 3, i * 3 + 3));
  const concurrency = options.concurrency ?? 3;
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 4) throw Error("Content writing concurrency must be between 1 and 4.");
  const results: unknown[][] = new Array(batches.length);
  let cursor = 0, failed = false;
  let failure: unknown;
  const worker = async () => {
    while (!failed) {
      const index = cursor++;
      if (index >= batches.length) return;
      const batch = batches[index];
      try {
      const instructions = request.instructions
        .replace(/The final response MUST contain exactly \d+ canonical content objects\./, `The final response MUST contain exactly ${batch.length} canonical content objects.`)
        .replace(/For every contentUnit from 1 through \d+, create exactly one object for every content stream\./, "Generate only the assigned contentUnit/platform pairs listed in the current writing batch.");
      const raw = await call({ ...request, instructions: instructions + "\nCURRENT WRITING BATCH: Return ONLY the assigned contentUnit/platform pairs. Preserve their original numbers. The full campaign plan is context; do not generate its other slots. Do not renumber, add or duplicate items. Each slot must develop a distinct idea appropriate to its place in the campaign.", input: request.input + `\n\nASSIGNED CONTENT ITEMS FOR THIS CALL:\n${JSON.stringify(batch)}`, maxOutputTokens: Math.max(4096, batch.length * 1800 + 1024) });
      let parsed: { posts?: { contentUnit: number; platform: string }[] };
      try { parsed = JSON.parse(raw.trim().replace(/^```(?:json)?\s*/, "").replace(/```\s*$/, "")); }
      catch { throw Error("The AI returned invalid batch content. Please try a smaller date range."); }
      const keys = new Set(batch.map(p => `${p.platform}:${p.contentUnit}`));
      if (!parsed || !Array.isArray(parsed.posts) || parsed.posts.length !== batch.length) throw Error("The AI returned an incomplete content batch. Please try again.");
      for (const post of parsed.posts) if (!post || !keys.delete(`${post.platform}:${post.contentUnit}`)) throw Error("The AI returned unexpected or duplicate content items. Please try again.");
      results[index] = parsed.posts;
      if (options.onBatch) {
        const completedCount = results.filter(Boolean).flat().length;
        try {
          await options.onBatch(parsed.posts, completedCount, identities.length);
        } catch (onBatchErr) {
          console.warn("[writeContentBatches] onBatch hook warning:", onBatchErr);
        }
      }
      } catch (error) {
        if (!failed) { failed = true; failure = error; }
        return;
      }
    }
  };
  // Drain already-started calls on failure; do not start further paid work or retry it.
  await Promise.all(Array.from({length: Math.min(concurrency, batches.length)}, () => worker()));
  if (failed) throw failure;
  return JSON.stringify({ posts: results.flat() });
}


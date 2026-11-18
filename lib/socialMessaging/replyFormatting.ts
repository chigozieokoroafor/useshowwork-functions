/** Plain-text formatting for messaging channels. Never invent punctuation or alter facts. */
export function formatInboxReply(input: string): string {
  const text = input.replace(/\r\n?/g, "\n").split("\n").map(line => line.replace(/[\t ]+/g," ").trim()).join("\n").replace(/\n{3,}/g,"\n\n").trim();
  if (!text) return "";
  const segmenter = typeof Intl.Segmenter === "function" ? new Intl.Segmenter("en", { granularity: "sentence" }) : null;
  return text.split(/\n\s*\n/).map(paragraph => {
    // Preserve intentional line breaks, lists and payment/contact detail blocks.
    if (paragraph.includes("\n") || /^(?:[-•*]|\d+[.)])\s/.test(paragraph) || paragraph.length <= 240) return paragraph;
    const sentences: string[] = [];
    for (const item of segmenter ? segmenter.segment(paragraph) : [{segment:paragraph,index:0}]) {
      // ICU can regard a URL query '?' as a sentence boundary. Only introduce
      // spacing where whitespace already existed in the source text.
      if (sentences.length && item.index > 0 && !/\s/.test(paragraph[item.index - 1]) && !/\s/.test(paragraph[item.index])) sentences[sentences.length - 1] += item.segment.trimEnd();
      else if (item.segment.trim()) sentences.push(item.segment.trim());
    }
    const blocks: string[] = [];
    let block: string[] = [];
    let size = 0;
    for (const sentence of sentences) {
      if (block.length && (block.length >= 2 || size + sentence.length > 280)) {
        blocks.push(block.join(" ")); block = []; size = 0;
      }
      block.push(sentence); size += sentence.length + 1;
    }
    if (block.length) blocks.push(block.join(" "));
    // For an unusually long unpunctuated sentence, add whitespace at word boundaries.
    // This preserves URLs, decimal numbers, punctuation and account identifiers verbatim.
    return blocks.flatMap(value => {
      if (value.length <= 360) return [value];
      const words = value.split(" ");
      const pieces: string[] = []; let wordsInBlock: string[] = [];
      for (const word of words) {
        if (wordsInBlock.length >= 35) { pieces.push(wordsInBlock.join(" ")); wordsInBlock = []; }
        wordsInBlock.push(word);
      }
      if (wordsInBlock.length) pieces.push(wordsInBlock.join(" "));
      return pieces;
    }).join("\n\n");
  }).join("\n\n");
}

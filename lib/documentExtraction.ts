// ─────────────────────────────────────────────
// BUSINESS DOCUMENT TEXT EXTRACTION — turns an uploaded PDF, Word
// doc, or plain text file into plain text the AI can actually read.
// Done server-side with lightweight libraries rather than sending the
// raw file to OpenAI itself, since plain text extraction is a solved,
// cheap problem that doesn't need an AI call of its own.
//
// PDFs use pdf2json, not pdf-parse — pdf-parse pulls in pdfjs-dist's
// browser-oriented rendering code, which references DOMMatrix (a
// browser-only graphics API that doesn't exist in Node.js at all),
// causing a hard crash in this server environment even though only
// plain text extraction was ever needed. pdf2json avoids that
// rendering path entirely.
//
// Requires two packages:
//   npm install pdf2json mammoth --save
// (pdf-parse can be removed if it was installed for this earlier.)
// ─────────────────────────────────────────────

export { ALLOWED_BUSINESS_DOCUMENT_TYPES, isAllowedBusinessDocumentType } from "./businessDocumentTypes";

/**
 * pdf2json has no reliable official TypeScript types, so it's
 * imported defensively as `any` rather than assuming a specific
 * export shape. Its API is event-based (not Promise-based), so this
 * wraps it in a Promise the rest of this file can simply await.
 */
async function extractPdfText(buffer: Buffer): Promise<string> {
  const PDFParserModule: any = await import("pdf2json");
  const PDFParser = PDFParserModule.default ?? PDFParserModule;

  return new Promise((resolve, reject) => {
    // The `1` here enables getRawTextContent()'s plain-text mode —
    // without it, the parser is set up for structured field/form
    // extraction instead of simple readable text.
    const parser = new PDFParser(null, 1);

    parser.on("pdfParser_dataError", (errData: any) => {
      reject(new Error(errData?.parserError ?? "Failed to parse PDF"));
    });

    parser.on("pdfParser_dataReady", () => {
      resolve(parser.getRawTextContent());
    });

    parser.parseBuffer(buffer);
  });
}

/**
 * Downloads the file from its public R2 URL and extracts plain text
 * from it, based on content type. Thrown errors are meant to be
 * caught by the caller and surfaced as a clear, specific message
 * rather than silently failing — a business document that can't be
 * read is worth telling the manager about directly.
 */
export async function extractTextFromDocument(fileUrl: string, contentType: string): Promise<string> {
  const res = await fetch(fileUrl);
  if (!res.ok) {
    throw new Error("Failed to download the uploaded document for processing");
  }
  const buffer = Buffer.from(await res.arrayBuffer());

  if (contentType === "application/pdf") {
    return extractPdfText(buffer);
  }

  if (contentType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
    const mammoth = await import("mammoth");
    const result = await mammoth.extractRawText({ buffer });
    return result.value;
  }

  if (contentType === "text/csv") {
    const { parse } = await import("csv-parse/sync");
    const rows = parse(buffer.toString("utf-8"), { bom: true, relax_column_count: true, skip_empty_lines: true }) as string[][];
    return readableTable(rows);
  }
  if (["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "application/vnd.ms-excel"].includes(contentType)) {
    const XLSX = await import("xlsx");
    const workbook = XLSX.read(buffer, { type: "buffer", cellDates: true });
    const sheets = workbook.SheetNames.map(name => {
      const sheet = workbook.Sheets[name];
      if (sheet["!ref"]) {
        const range = XLSX.utils.decode_range(sheet["!ref"]);
        if (range.e.r - range.s.r > 5000 || range.e.c - range.s.c > 80) throw new Error("This spreadsheet is too large. Split it into smaller price lists.");
      }
      const rows = XLSX.utils.sheet_to_json<string[]>(sheet, { header: 1, defval: "", raw: false, blankrows: false });
      const text = readableTable(rows);
      return text ? `Sheet: ${name}\n${text}` : "";
    }).filter(Boolean);
    const text = sheets.join("\n\n");
    if (text.length > 100000) throw new Error("This spreadsheet is too large. Split it into smaller price lists.");
    return text;
  }

  if (contentType === "text/plain") {
    return buffer.toString("utf-8");
  }

  throw new Error("That file type isn't supported for business documents");
}
function readableTable(rows: unknown[][]): string {
  if (rows.length > 5000 || rows.some(row => row.length > 80)) throw new Error("This sheet is too large. Split it into smaller price lists.");
  const text = rows.filter(row => row.some(value => String(value ?? "").trim())).map(row => row.map(value => JSON.stringify(String(value ?? ""))).join(" | ")).join("\n");
  if (text.length > 100000) throw new Error("This sheet is too large. Split it into smaller price lists.");
  return text;
}

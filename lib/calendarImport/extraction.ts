import { parse } from "csv-parse/sync";
import { randomUUID } from "node:crypto";
import { suggestField, type SourceItem } from "./mapping";
import { extractCalendarItems } from "@/lib/openai";

export const MAX_IMPORT_BYTES = 3 * 1024 * 1024;
export const MAX_IMPORT_ITEMS = 200;
const MAX_TEXT = 60000;

export function tableItems(matrix: unknown[][], sheet: string): SourceItem[] {
  if (matrix.length > 2000)
    throw new Error(
      "This sheet has too many rows. Split the calendar into smaller files.",
    );
  const nonempty = matrix
    .map((row, index) => ({
      row: row.map((value) => String(value ?? "")),
      index,
    }))
    .filter(({ row }) => row.some((value) => value.trim()));
  if (!nonempty.length) return [];
  const headerIndex = nonempty
    .slice(0, 30)
    .findIndex(
      ({ row }) =>
        row.filter((value) => suggestField(value) !== "custom").length >= 2,
    );
  const headerRow = headerIndex >= 0 ? nonempty[headerIndex] : null;
  const width = Math.max(...nonempty.map(({ row }) => row.length));
  if (width > 50)
    throw new Error(
      "At most 50 columns are supported. Remove unused columns before importing.",
    );
  const headers = Array.from(
    { length: width },
    (_, i) => headerRow?.row[i]?.trim() || `Column ${i + 1}`,
  );
  const seen = new Map<string, number>();
  const uniqueHeaders = headers.map((header) => {
    const count = (seen.get(header) ?? 0) + 1;
    seen.set(header, count);
    return count === 1 ? header : `${header} (${count})`;
  });
  return nonempty
    .slice(headerIndex >= 0 ? headerIndex + 1 : 0)
    .map(({ row, index }) => ({
      id: randomUUID(),
      source: `${sheet}, row ${index + 1}`,
      values: Object.fromEntries(
        uniqueHeaders.map((header, i) => [header, row[i] ?? ""]),
      ),
      warnings: headerRow
        ? []
        : ["No header row detected. Choose the column mappings."],
    }));
}

async function pdfText(buffer: Buffer): Promise<string> {
  const module = await import("pdf2json");
  const PDFParser = module.default;
  return new Promise((resolve, reject) => {
    const parser = new PDFParser(null, true);
    const timeout = setTimeout(() => {
      parser.destroy();
      reject(new Error("PDF extraction timed out. Try a smaller file."));
    }, 20000);
    parser.on("pdfParser_dataError", () => {
      clearTimeout(timeout);
      reject(new Error("The PDF is encrypted, damaged, or unreadable."));
    });
    parser.on("pdfParser_dataReady", (data) => {
      clearTimeout(timeout);
      try {
        // Preserve PDF line/column positions instead of flattening a table into unrelated words.
        const text = data.Pages.map((page, index) => {
          const lines: { y: number; parts: { x: number; text: string }[] }[] =
            [];
          for (const item of [...page.Texts].sort(
            (a, b) => a.y - b.y || a.x - b.x,
          )) {
            const last = lines[lines.length - 1];
            const line =
              last && Math.abs(last.y - item.y) < 0.15
                ? last
                : { y: item.y, parts: [] };
            if (line !== last) lines.push(line);
            line.parts.push({
              x: item.x,
              text: item.R.map((run) => decodeURIComponent(run.T)).join(""),
            });
          }
          return lines.length
            ? `Page ${index + 1}\n${lines
                .map((line) =>
                  line.parts
                    .sort((a, b) => a.x - b.x)
                    .map((part) => part.text)
                    .join(" | "),
                )
                .join("\n")}`
            : "";
        }).join("\n\n");
        resolve(text);
      } catch {
        reject(
          new Error(
            "The PDF text could not be decoded. Export a text PDF or spreadsheet.",
          ),
        );
      }
    });
    // pdf2json reads Buffer.buffer without respecting byteOffset. Small Buffers can share a pool.
    const standalone = Buffer.alloc(buffer.length);
    buffer.copy(standalone);
    try {
      parser.parseBuffer(standalone);
    } catch (error) {
      clearTimeout(timeout);
      reject(error);
    }
  });
}

export async function extractImport(
  buffer: Buffer,
  filename: string,
): Promise<{ items: SourceItem[]; method: string }> {
  if (!buffer.length || buffer.length > MAX_IMPORT_BYTES)
    throw new Error("Choose a nonempty file up to 3 MB.");
  const ext = filename.split(".").pop()?.toLowerCase();
  const zip = buffer.subarray(0, 2).toString() === "PK";
  const ole = buffer.subarray(0, 8).toString("hex") === "d0cf11e0a1b11ae1";
  let items: SourceItem[];
  let method = "Table extraction";
  if (ext === "xlsx" || ext === "xls") {
    if ((ext === "xlsx" && !zip) || (ext === "xls" && !ole))
      throw new Error("The file contents do not match its Excel extension.");
    if (zip) await validateZip(buffer);
    const XLSX = await import("xlsx");
    const workbook = XLSX.read(buffer, {
      type: "buffer",
      cellDates: false,
      cellNF: true,
      cellFormula: false,
      sheetRows: 2002,
    });
    if (workbook.SheetNames.length > 20)
      throw new Error("At most 20 sheets are supported.");
    items = workbook.SheetNames.flatMap((name) => {
      const sheet = workbook.Sheets[name];
      if (sheet["!fullref"] && sheet["!fullref"] !== sheet["!ref"])
        throw new Error(
          "This sheet exceeds the row limit. Split it into smaller files.",
        );
      const range = XLSX.utils.decode_range(sheet["!ref"] ?? "A1");
      if (range.e.c - range.s.c + 1 > 50)
        throw new Error(
          "At most 50 columns are supported. Remove unused columns before importing.",
        );
      if (range.e.r - range.s.r + 1 > 2000)
        throw new Error(
          "This sheet exceeds the row limit. Split it into smaller files.",
        );
      // Excel serials are wall dates/times, not UTC instants. Decode the workbook's date system directly.
      for (const [address, cell] of Object.entries(sheet)) {
        if (
          address.startsWith("!") ||
          !cell ||
          cell.t !== "n" ||
          !cell.z ||
          !XLSX.SSF.is_date(cell.z)
        )
          continue;
        const parts = XLSX.SSF.parse_date_code(cell.v, {
          date1904: !!workbook.Workbook?.WBProps?.date1904,
        });
        if (!parts) continue;
        if (parts.y === 1900 && parts.m === 2 && parts.d === 29)
          throw new Error(
            "Excel contains the invalid date 1900-02-29. Correct it before importing.",
          );
        const time = `${String(parts.H).padStart(2, "0")}:${String(parts.M).padStart(2, "0")}:${String(parts.S).padStart(2, "0")}`;
        const date = `${parts.y}-${String(parts.m).padStart(2, "0")}-${String(parts.d).padStart(2, "0")}`;
        cell.t = "s";
        cell.v = cell.v < 1 ? time : cell.v % 1 ? `${date}T${time}` : date;
        cell.w = String(cell.v);
      }
      return tableItems(
        XLSX.utils.sheet_to_json<unknown[]>(sheet, {
          header: 1,
          raw: false,
          defval: "",
          blankrows: true,
        }),
        name,
      );
    });
  } else if (ext === "csv") {
    const text = decodeText(buffer);
    const first = text.split(/\r?\n/, 1)[0];
    const delimiter = [",", ";", "\t"].sort(
      (a, b) => first.split(b).length - first.split(a).length,
    )[0];
    items = tableItems(parseTable(text, delimiter), filename);
  } else {
    let text: string;
    if (ext === "pdf") {
      if (!buffer.subarray(0, 5).equals(Buffer.from("%PDF-")))
        throw new Error("The file is not a PDF.");
      text = await pdfText(buffer);
    } else if (ext === "docx") {
      if (!zip) throw new Error("The file is not a DOCX document.");
      await validateZip(buffer);
      const mammoth = await import("mammoth");
      // HTML retains table rows/cells for semantic extraction; it is never rendered in the UI.
      text = (
        await mammoth.convertToHtml(
          { buffer },
          {
            convertImage: mammoth.images.imgElement(() =>
              Promise.resolve({ src: "" }),
            ),
          },
        )
      ).value;
    } else if (ext === "doc") {
      if (!ole) throw new Error("The file is not a legacy Word document.");
      const { default: WordExtractor } = await import("word-extractor");
      text = (await new WordExtractor().extract(buffer)).getBody();
    } else if (ext === "txt") {
      text = decodeText(buffer);
      if (text.includes("\t")) {
        items = tableItems(parseTable(text, "\t"), filename);
        return checkItems(items, method);
      }
    } else throw new Error("Use PDF, CSV, XLS, XLSX, DOC, DOCX, or TXT.");
    if (!text.replace(/<[^>]*>/g, "").trim())
      throw new Error(
        "No readable text found. Scanned PDFs need OCR first; export a text PDF or spreadsheet.",
      );
    if (text.length > MAX_TEXT)
      throw new Error(
        "This document is too large to interpret reliably. Split it into smaller files.",
      );
    items = await extractCalendarItems(text, filename);
    method =
      "Document interpretation — review extracted copy and dates against the source";
  }
  return checkItems(items, method);
}

function checkItems(items: SourceItem[], method: string) {
  if (!items.length)
    throw new Error("No content items were found in this file.");
  if (items.length > MAX_IMPORT_ITEMS)
    throw new Error(
      `At most ${MAX_IMPORT_ITEMS} items per import. Split the calendar into smaller files.`,
    );
  if (JSON.stringify(items).length > 500000)
    throw new Error(
      "Extracted content is too large. Split the file into smaller calendars.",
    );
  return { items, method };
}
function decodeText(buffer: Buffer) {
  const utf16 = buffer[0] === 0xff && buffer[1] === 0xfe;
  const text = buffer
    .toString(utf16 ? "utf16le" : "utf8")
    .replace(/^\uFEFF/, "");
  if (text.includes("\0") || text.includes("\uFFFD"))
    throw new Error("Use a UTF-8 or UTF-16 text/CSV file.");
  return text;
}

function parseTable(text: string, delimiter: string): string[][] {
  let count = 0;
  return parse(text, {
    delimiter,
    bom: true,
    relax_column_count: true,
    skip_empty_lines: true,
    max_record_size: 100000,
    on_record: (record: string[]) => {
      if (++count > 2000)
        throw new Error(
          "This file exceeds the row limit. Split it into smaller files.",
        );
      if (record.length > 50)
        throw new Error("At most 50 columns are supported.");
      return record;
    },
  });
}
async function validateZip(buffer: Buffer) {
  // Check the central directory before decompression to bound zip expansion.
  const end = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (end < 0 || end + 22 > buffer.length)
    throw new Error("Invalid document archive.");
  const entries = buffer.readUInt16LE(end + 10);
  let offset = buffer.readUInt32LE(end + 16),
    total = 0;
  if (entries > 2000 || entries === 0xffff)
    throw new Error("Document archive is too complex.");
  for (let i = 0; i < entries; i++) {
    if (
      offset + 46 > buffer.length ||
      buffer.readUInt32LE(offset) !== 0x02014b50
    )
      throw new Error("Invalid document archive.");
    total += buffer.readUInt32LE(offset + 24);
    if (total > 20 * 1024 * 1024)
      throw new Error("Expanded document exceeds 20 MB.");
    offset +=
      46 +
      buffer.readUInt16LE(offset + 28) +
      buffer.readUInt16LE(offset + 30) +
      buffer.readUInt16LE(offset + 32);
  }
}

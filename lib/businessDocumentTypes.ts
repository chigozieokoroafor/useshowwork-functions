const BUSINESS_DOCUMENT_EXTENSIONS: Record<string, string> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  txt: "text/plain",
  csv: "text/csv",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  xls: "application/vnd.ms-excel",
};
export const ALLOWED_BUSINESS_DOCUMENT_TYPES = Object.values(BUSINESS_DOCUMENT_EXTENSIONS);
export const BUSINESS_DOCUMENT_ACCEPT = Object.keys(BUSINESS_DOCUMENT_EXTENSIONS).map(extension => `.${extension}`).join(",");
export function isAllowedBusinessDocumentType(contentType: string): boolean {
  return ALLOWED_BUSINESS_DOCUMENT_TYPES.includes(contentType);
}
export function businessDocumentType(file: { name: string; type: string }) {
  return BUSINESS_DOCUMENT_EXTENSIONS[file.name.split(".").pop()?.toLowerCase() || ""] || file.type.split(";")[0].trim().toLowerCase();
}

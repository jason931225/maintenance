export type SourceTextEncoding = "utf-8" | "utf-8-bom" | "utf-16le" | "utf-16be" | "euc-kr";

export interface DecodedSourceText {
  text: string;
  encoding: SourceTextEncoding;
  hadBom: boolean;
}

const UTF8_BOM = [0xef, 0xbb, 0xbf] as const;
const UTF16LE_BOM = [0xff, 0xfe] as const;
const UTF16BE_BOM = [0xfe, 0xff] as const;

function startsWith(bytes: Uint8Array, prefix: readonly number[]): boolean {
  return prefix.every((byte, index) => bytes[index] === byte);
}

function stripByteOrderMark(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function strictDecode(bytes: Uint8Array, encoding: string): string | undefined {
  try {
    return new TextDecoder(encoding, { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

/**
 * Decodes user-supplied tabular text while preserving Korean CSV exports.
 *
 * Groupware/Excel CSV exports in Korea are often CP949/Windows-949, exposed by
 * the WHATWG Encoding API as the `euc-kr` decoder label. We try strict UTF-8
 * first to avoid damaging modern exports, then strict EUC-KR so legacy Hangul
 * does not become mojibake before the column-mapping preview renders.
 */
export function decodeSourceText(input: ArrayBuffer | Uint8Array): DecodedSourceText {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);

  if (startsWith(bytes, UTF8_BOM)) {
    return {
      text: stripByteOrderMark(new TextDecoder("utf-8").decode(bytes)),
      encoding: "utf-8-bom",
      hadBom: true,
    };
  }

  if (startsWith(bytes, UTF16LE_BOM)) {
    return {
      text: stripByteOrderMark(new TextDecoder("utf-16le").decode(bytes)),
      encoding: "utf-16le",
      hadBom: true,
    };
  }

  if (startsWith(bytes, UTF16BE_BOM)) {
    return {
      text: stripByteOrderMark(new TextDecoder("utf-16be").decode(bytes)),
      encoding: "utf-16be",
      hadBom: true,
    };
  }

  const utf8 = strictDecode(bytes, "utf-8");
  if (utf8 !== undefined) {
    return { text: stripByteOrderMark(utf8), encoding: "utf-8", hadBom: false };
  }

  const eucKr = strictDecode(bytes, "euc-kr");
  if (eucKr !== undefined) {
    return { text: stripByteOrderMark(eucKr), encoding: "euc-kr", hadBom: false };
  }

  // Last-resort readable fallback for validation errors. Downstream dry-run must
  // surface the replacement characters instead of silently applying imports.
  return {
    text: stripByteOrderMark(new TextDecoder("utf-8").decode(bytes)),
    encoding: "utf-8",
    hadBom: false,
  };
}

export interface ParsedCsvSource {
  decoded: DecodedSourceText;
  rows: string[][];
}

export function decodeCsvSource(input: ArrayBuffer | Uint8Array): ParsedCsvSource {
  const decoded = decodeSourceText(input);
  return { decoded, rows: parseCsvRows(decoded.text) };
}

export function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];

    if (inQuotes) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          cell += '"';
          index += 1;
        } else {
          inQuotes = false;
        }
      } else {
        cell += char;
      }
      continue;
    }

    if (char === '"' && cell.length === 0) {
      inQuotes = true;
      continue;
    }

    if (char === ",") {
      row.push(cell);
      cell = "";
      continue;
    }

    if (char === "\r" || char === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      if (char === "\r" && text[index + 1] === "\n") {
        index += 1;
      }
      continue;
    }

    cell += char;
  }

  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }

  return rows;
}

const FORMULA_PREFIX = /^[=+\-@\t\r]/;

function neutralizeSpreadsheetFormula(cell: string): string {
  return FORMULA_PREFIX.test(cell) ? `'${cell}` : cell;
}

function formatCsvCell(value: string | number | boolean | null | undefined): string {
  const raw = value == null ? "" : String(value);
  const safe = neutralizeSpreadsheetFormula(raw);
  const escaped = safe.replaceAll('"', '""');
  return /[",\r\n]/.test(escaped) ? `"${escaped}"` : escaped;
}

/**
 * Formats canonical export rows as RFC-4180-style CSV: stable CRLF row breaks,
 * consistent cell counts as provided by the caller, quoted cells when needed,
 * and spreadsheet-formula neutralization for values that would otherwise be
 * executed by Excel/Sheets after download.
 */
export function formatCsvRows(
  rows: readonly (readonly (string | number | boolean | null | undefined)[])[],
): string {
  return rows.map((row) => row.map(formatCsvCell).join(",")).join("\r\n");
}

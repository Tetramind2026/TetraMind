export type CsvImportResult = {
  headers: string[];
  records: string[][];
};

function detectDelimiter(headerLine: string): string {
  const candidates = [",", ";", "\t"];
  let bestDelimiter = ",";
  let bestCount = 0;

  for (const delimiter of candidates) {
    let count = 0;
    let insideQuotes = false;

    for (let index = 0; index < headerLine.length; index += 1) {
      const character = headerLine[index];

      if (character === '"') {
        if (insideQuotes && headerLine[index + 1] === '"') {
          index += 1;
        } else {
          insideQuotes = !insideQuotes;
        }
      } else if (character === delimiter && !insideQuotes) {
        count += 1;
      }
    }

    if (count > bestCount) {
      bestDelimiter = delimiter;
      bestCount = count;
    }
  }

  return bestDelimiter;
}

function parseRows(content: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let value = "";
  let insideQuotes = false;

  for (let index = 0; index < content.length; index += 1) {
    const character = content[index];

    if (character === '"') {
      if (insideQuotes && content[index + 1] === '"') {
        value += '"';
        index += 1;
      } else {
        insideQuotes = !insideQuotes;
      }
    } else if (character === delimiter && !insideQuotes) {
      row.push(value.trim());
      value = "";
    } else if ((character === "\n" || character === "\r") && !insideQuotes) {
      if (character === "\r" && content[index + 1] === "\n") {
        index += 1;
      }
      row.push(value.trim());
      if (row.some((cell) => cell !== "")) {
        rows.push(row);
      }
      row = [];
      value = "";
    } else {
      value += character;
    }
  }

  if (value !== "" || row.length > 0) {
    row.push(value.trim());
    if (row.some((cell) => cell !== "")) {
      rows.push(row);
    }
  }

  return rows;
}

export function parseCsv(content: string): CsvImportResult {
  const normalizedContent = content.replace(/^\uFEFF/, "");
  const firstLine = normalizedContent.split(/\r?\n/, 1)[0] ?? "";
  const rows = parseRows(normalizedContent, detectDelimiter(firstLine));
  const headers = rows[0] ?? [];
  const records = rows.slice(1).filter((row) => row.some((cell) => cell !== ""));

  return { headers, records };
}
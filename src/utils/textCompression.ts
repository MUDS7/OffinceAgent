export type TextEditContentEncoding = "json_minified" | "text_whitespace_compacted";

export type CompressedTextPayload = {
  encoding?: TextEditContentEncoding;
  text: string;
};

const TEXT_COMPRESSION_EXTENSIONS = new Set(["json", "txt"]);

export function compressTextEditPayload(filename: string, text: string): CompressedTextPayload {
  if (!text || !shouldCompressTextFile(filename)) {
    return { text };
  }

  if (getFileExtension(filename) === "json") {
    const minified = minifyJsonText(text);
    if (minified !== null && minified.length < text.length) {
      return {
        encoding: "json_minified",
        text: minified,
      };
    }
  }

  const compacted = compactPlainTextWhitespace(text);
  if (compacted.length < text.length) {
    return {
      encoding: "text_whitespace_compacted",
      text: compacted,
    };
  }

  return { text };
}

export function restoreTextEditPayload(
  filename: string,
  text: string,
  originalText: string,
  encoding?: TextEditContentEncoding,
) {
  if (!encoding || !shouldCompressTextFile(filename)) {
    return text;
  }

  if (encoding === "json_minified") {
    return restoreJsonFormatting(text, originalText);
  }

  return restorePlainTextWhitespace(text, originalText);
}

function shouldCompressTextFile(filename: string) {
  return TEXT_COMPRESSION_EXTENSIONS.has(getFileExtension(filename));
}

function minifyJsonText(text: string) {
  try {
    return JSON.stringify(JSON.parse(text));
  } catch {
    return null;
  }
}

function restoreJsonFormatting(text: string, originalText: string) {
  try {
    const parsed = JSON.parse(text);
    const indent = detectJsonIndent(originalText);
    const restored = indent > 0 ? JSON.stringify(parsed, null, indent) : JSON.stringify(parsed);
    return originalText.endsWith("\n") && !restored.endsWith("\n") ? `${restored}\n` : restored;
  } catch {
    return text;
  }
}

function detectJsonIndent(text: string) {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const indentedLine = lines.find((line) => /^ +\S/.test(line));
  return indentedLine?.match(/^ +/)?.[0].length ?? 0;
}

function compactPlainTextWhitespace(text: string) {
  return text.replace(/\s+/g, " ").trim();
}

function restorePlainTextWhitespace(text: string, originalText: string) {
  if (compactPlainTextWhitespace(originalText) === compactPlainTextWhitespace(text)) {
    return originalText;
  }

  const originalParts = splitWhitespaceParts(originalText);
  const nextParts = splitWhitespaceParts(text);
  const restored: string[] = [];
  let originalIndex = 0;
  let previousWasToken = false;

  for (const part of nextParts) {
    if (part.isWhitespace) continue;

    const matchedIndex = findNextToken(originalParts, part.value, originalIndex);
    if (matchedIndex >= 0) {
      restored.push(getLeadingWhitespace(originalParts, matchedIndex));
      restored.push(part.value);
      originalIndex = matchedIndex + 1;
      previousWasToken = true;
      continue;
    }

    restored.push(previousWasToken ? " " : getInitialWhitespace(originalParts));
    restored.push(part.value);
    previousWasToken = true;
  }

  const trailingWhitespace = getTrailingWhitespace(originalParts, originalIndex);
  return `${restored.join("")}${trailingWhitespace}`;
}

function splitWhitespaceParts(text: string) {
  return (text.match(/\s+|\S+/g) ?? []).map((value) => ({
    isWhitespace: /^\s+$/.test(value),
    value,
  }));
}

function findNextToken(parts: ReturnType<typeof splitWhitespaceParts>, token: string, startIndex: number) {
  for (let index = startIndex; index < parts.length; index += 1) {
    if (!parts[index].isWhitespace && parts[index].value === token) {
      return index;
    }
  }

  return -1;
}

function getLeadingWhitespace(parts: ReturnType<typeof splitWhitespaceParts>, tokenIndex: number) {
  const previousPart = parts[tokenIndex - 1];
  return previousPart?.isWhitespace ? previousPart.value : "";
}

function getInitialWhitespace(parts: ReturnType<typeof splitWhitespaceParts>) {
  return parts[0]?.isWhitespace ? parts[0].value : "";
}

function getTrailingWhitespace(parts: ReturnType<typeof splitWhitespaceParts>, startIndex: number) {
  for (let index = parts.length - 1; index >= startIndex; index -= 1) {
    if (!parts[index].isWhitespace) return "";
  }

  const lastPart = parts[parts.length - 1];
  return lastPart?.isWhitespace ? lastPart.value : "";
}

function getFileExtension(filename: string) {
  return filename.split(".").pop()?.toLowerCase() ?? "";
}

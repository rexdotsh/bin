export const strip = (s: string) =>
  s
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[@-Z\\-_]/g, "");

export const segments = (line: string) => {
  const parts = line.split("\r");
  while (parts.length > 1 && parts[parts.length - 1] === "") parts.pop();
  return parts;
};

export function splitLines(text: string): string[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

export const plainLine = (line: string) => (line.includes("\x1b") || line.includes("\r") ? strip(segments(line).pop() ?? "") : line);

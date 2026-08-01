import { existsSync, fstatSync, openSync, readSync, closeSync } from "node:fs";

export type OutputFileTail = {
  text: string;
  sourceBytes: number;
  sourceTruncated: boolean;
};

const MAX_OUTPUT_FILE_READ_BYTES = 1024 * 1024;
const UTF8_MAX_BYTES = 4;

const firstCompleteUtf8Byte = (buffer: Buffer): number => {
  let offset = 0;
  while (offset < buffer.length && (buffer[offset]! & 0xc0) === 0x80) offset += 1;
  return offset;
};

const completeUtf8End = (buffer: Buffer): number => {
  if (buffer.length === 0) return 0;

  let lead = buffer.length - 1;
  while (lead >= 0 && (buffer[lead]! & 0xc0) === 0x80) lead -= 1;
  if (lead < 0) return 0;

  const leadByte = buffer[lead]!;
  const expectedBytes =
    leadByte <= 0x7f
      ? 1
      : leadByte >= 0xc2 && leadByte <= 0xdf
        ? 2
        : leadByte >= 0xe0 && leadByte <= 0xef
          ? 3
          : leadByte >= 0xf0 && leadByte <= 0xf4
            ? 4
            : 1;
  return buffer.length - lead < expectedBytes ? lead : buffer.length;
};

export const readOutputFileTail = (
  outputFile: string | undefined,
  maxBytes: number,
): OutputFileTail | null => {
  if (!outputFile || !existsSync(outputFile)) return null;

  let file: number;
  try {
    file = openSync(outputFile, "r");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  try {
    let sourceBytes = fstatSync(file).size;
    const requestedBytes =
      sourceBytes <= MAX_OUTPUT_FILE_READ_BYTES
        ? sourceBytes
        : Math.min(Math.max(1, Math.floor(maxBytes)), MAX_OUTPUT_FILE_READ_BYTES);
    for (let attempt = 0; ; attempt += 1) {
      const bytesToRead = Math.min(sourceBytes, requestedBytes + UTF8_MAX_BYTES - 1);
      const position = Math.max(0, sourceBytes - bytesToRead);
      const buffer = Buffer.allocUnsafe(bytesToRead);
      let bytesRead = 0;

      while (bytesRead < bytesToRead) {
        const count = readSync(
          file,
          buffer,
          bytesRead,
          bytesToRead - bytesRead,
          position + bytesRead,
        );
        if (count === 0) break;
        bytesRead += count;
      }

      if (bytesRead < bytesToRead && attempt === 0) {
        sourceBytes = fstatSync(file).size;
        continue;
      }

      const completeStart = position > 0 ? firstCompleteUtf8Byte(buffer.subarray(0, bytesRead)) : 0;
      const completeEnd = completeUtf8End(buffer.subarray(completeStart, bytesRead)) + completeStart;
      return {
        text: buffer.subarray(completeStart, completeEnd).toString("utf-8"),
        sourceBytes,
        sourceTruncated: position + completeStart > 0,
      };
    }
  } finally {
    closeSync(file);
  }
};
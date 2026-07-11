export type UnwrapHypaCommandResult = {
  command: string;
  unwrapped: boolean;
  original: string;
};

const stripSurroundingQuotes = (value: string): string => {
  if (value.length < 2) return value;

  if (value.startsWith('"') && value.endsWith('"')) {
    return value
      .slice(1, -1)
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, "\\");
  }

  if (value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1);
  }

  return value;
};

const HYPA_C_WRAPPER =
  /^hypa(?:\s+--timeout-ms\s+\d+|\s+--[A-Za-z0-9][\w-]*(?:[= ]\S+)?)?\s+-c\s+([\s\S]+)$/;

const INTENTIONAL_HYPA_SUBCOMMAND =
  /^hypa\s+(compress|raw|rewrite|filters|doctor|git|dotnet|docker|kubectl)\b/;

export const unwrapHypaCommandWrapper = (command: string): UnwrapHypaCommandResult => {
  const original = command;
  const trimmed = command.trim();

  if (!trimmed.startsWith("hypa") || INTENTIONAL_HYPA_SUBCOMMAND.test(trimmed)) {
    return { command: original, unwrapped: false, original };
  }

  const match = trimmed.match(HYPA_C_WRAPPER);
  if (!match?.[1]) {
    return { command: original, unwrapped: false, original };
  }

  const inner = stripSurroundingQuotes(match[1].trim());
  if (!inner) {
    return { command: original, unwrapped: false, original };
  }

  return { command: inner, unwrapped: true, original };
};

export const resolveExecutableCommand = (
  command: string,
  unwrap: boolean,
): UnwrapHypaCommandResult =>
  unwrap ? unwrapHypaCommandWrapper(command) : { command, unwrapped: false, original: command };

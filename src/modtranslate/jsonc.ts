// Very small JSONC parser: strips // and /* */ comments.

export function stripJsonComments(input: string): string {
  const noLine = input.replace(/(^|\s)\/\/.*$/gm, "$1");
  return noLine.replace(/\/\*[\s\S]*?\*\//g, "");
}

export function parseJsoncObject(input: string, label = "<json>"): Record<string, unknown> {
  const cleaned = stripJsonComments(input);
  try {
    const v = JSON.parse(cleaned) as unknown;
    if (!v || typeof v !== "object" || Array.isArray(v)) {
      throw new Error("Expected an object at top-level");
    }
    return v as Record<string, unknown>;
  } catch (e) {
    throw new Error(`Failed to parse JSON (${label}): ${String(e)}`);
  }
}

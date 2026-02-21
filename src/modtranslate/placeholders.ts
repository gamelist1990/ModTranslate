export type ProtectedText = {
  text: string;
  restore: (translated: string) => string;
};

const TOKEN_PREFIX = "__MT";
const TOKEN_SUFFIX = "__";

const PLACEHOLDER_PATTERNS: RegExp[] = [
  /%(\d+\$)?[-+#0 ]*\d*(?:\.\d+)?[a-zA-Z]/g,
  /\{\d+\}/g,
  /§[0-9a-fk-or]/gi,
  /\n/g,
  /\t/g,
  /\r/g,
];

export function protectPlaceholders(input: string): ProtectedText {
  const replacements = new Map<string, string>();
  let current = input;
  let index = 0;

  for (const re of PLACEHOLDER_PATTERNS) {
    current = current.replace(re, (match) => {
      const token = `${TOKEN_PREFIX}${index++}${TOKEN_SUFFIX}`;
      replacements.set(token, match);
      return token;
    });
  }

  return {
    text: current,
    restore: (translated: string) => {
      let out = translated;
      for (const [token, original] of replacements) {
        out = out.split(token).join(original);
      }
      return out;
    },
  };
}

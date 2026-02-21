declare module "cli-table3" {
  export type CliTable3Options = {
    head?: string[];
    colWidths?: number[];
    colAligns?: Array<"left" | "middle" | "right">;
    wordWrap?: boolean;
    wrapOnWordBoundary?: boolean;
    style?: {
      head?: string[];
      border?: string[];
      compact?: boolean;
    };
  };

  class Table {
    constructor(options?: CliTable3Options);
    push(...rows: Array<any[] | Record<string, any>>): number;
    toString(): string;
  }

  export default Table;
}

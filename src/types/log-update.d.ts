declare module "log-update" {
  export type LogUpdate = {
    (output: string): void;
    clear: () => void;
    done: () => void;
  };

  const logUpdate: LogUpdate;
  export default logUpdate;
}

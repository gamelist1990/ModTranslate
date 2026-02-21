import { readdir } from "node:fs/promises";
import path from "node:path";

export type JarFile = {
  name: string;
  absPath: string;
};

export async function listJarFiles(dir: string): Promise<JarFile[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  return entries
    .filter((e) => e.isFile() && e.name.toLowerCase().endsWith(".jar"))
    .map((e) => ({ name: e.name, absPath: path.resolve(dir, e.name) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

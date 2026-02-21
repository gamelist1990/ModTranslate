import path from "node:path";

type WriteLangFileOpts = {
  outDir: string;
  namespace: string;
  langFileStem: string;
  json: Record<string, unknown>;
};

export async function ensureResourcePackBase(outDir: string): Promise<void> {
  const packMcmetaPath = path.join(outDir, "pack.mcmeta");
  const exists = await Bun.file(packMcmetaPath).exists();
  if (!exists) {
    const mcmeta = {
      pack: {
        pack_format: 15,
        description: "Auto Generated Resource Pack for ModTranslate",
      },
    };
    await Bun.write(packMcmetaPath, JSON.stringify(mcmeta, null, 4));
  }
}

export async function writeLangFile(opts: WriteLangFileOpts): Promise<void> {
  const filePath = path.join(
    opts.outDir,
    "assets",
    opts.namespace,
    "lang",
    `${opts.langFileStem}.json`,
  );
  await Bun.write(filePath, JSON.stringify(opts.json, null, 2));
}

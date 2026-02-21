import JSZip from "jszip";

export async function loadJarZip(jarPath: string): Promise<JSZip> {
  const buf = await Bun.file(jarPath).arrayBuffer();
  return await JSZip.loadAsync(buf);
}

export async function saveJarZip(zip: JSZip, jarPath: string): Promise<void> {
  // NOTE: Overwrites the jar. Callers should create a backup if needed.
  const out = await zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 9 },
  });
  await Bun.write(jarPath, out);
}

export function removeZipFile(zip: JSZip, zipPath: string): void {
  zip.remove(zipPath);
}

export function zipHasFile(zip: JSZip, zipPath: string): boolean {
  return zip.file(zipPath) !== null;
}

export async function readZipText(zip: JSZip, zipPath: string): Promise<string> {
  const f = zip.file(zipPath);
  if (!f) throw new Error(`Zip entry not found: ${zipPath}`);
  return await f.async("string");
}

export function listAssetNamespaces(zip: JSZip): string[] {
  const namespaces = new Set<string>();
  for (const p of Object.keys(zip.files)) {
    if (!p.startsWith("assets/")) continue;
    const parts = p.split("/");
    if (parts.length < 2) continue;
    const ns = parts[1];
    if (ns) namespaces.add(ns);
  }
  return [...namespaces].sort();
}

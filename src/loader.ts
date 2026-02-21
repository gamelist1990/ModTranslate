import chalk from "chalk";
import inquirer from "inquirer";
import path from "node:path";
import cliProgress from "cli-progress";
import { performance } from "node:perf_hooks";

import { createRunScreenAnsi, type RunScreenStats as TermRunScreenStats } from "./ui/run_screen_ansi";

import { ensureResourcePackBase, writeLangFile } from "./modtranslate/resourcepack";
import { listJarFiles } from "./modtranslate/fs";
import { loadJarZip, listAssetNamespaces, readZipText, removeZipFile, saveJarZip, zipHasFile } from "./modtranslate/jar";
import { parseJsoncObject } from "./modtranslate/jsonc";
import { normalizeMcLangFileStem, toGoogleLang } from "./modtranslate/lang";
import { createTranslator } from "./modtranslate/translate";

type CliOptions = {
	dir: string;
	outDir: string;
	source: string; 
	target: string; 
	jars: string[]; 
	yes: boolean;
	repairBrokenTargetInJar: boolean;
	backupJars: boolean;
};

const COMMON_MC_LANGS = [
	"en_us",
	"en_gb",
	"ja_jp",
	"ko_kr",
	"zh_cn",
	"zh_tw",
	"fr_fr",
	"de_de",
	"es_es",
	"pt_br",
	"it_it",
	"ru_ru",
] as const;

function printHeader() {
	console.log(chalk.bold.cyan("\nModTranslate"), chalk.gray("- Minecraft Mod 翻訳ツール (Bun)"));
}

function formatDuration(ms: number): string {
	const total = Math.max(0, Math.floor(ms / 1000));
	const h = Math.floor(total / 3600);
	const m = Math.floor((total % 3600) / 60);
	const s = total % 60;
	if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
	return `${m}:${String(s).padStart(2, "0")}`;
}

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

type RunUi = {
	update: (patch: Record<string, unknown>) => void;
	log: (line: string) => void;
	finish: (line?: string) => Promise<void>;
	requestAbort: () => void;
	isAborted: () => boolean;
	stop: () => void;
};

function createCliRunUi(totalMods: number): RunUi {
	let aborted = false;
	const startedAt = performance.now();

	const multibar = new cliProgress.MultiBar(
		{
			clearOnComplete: false,
			hideCursor: true,
			stopOnComplete: false,
			forceRedraw: true,
		},
		cliProgress.Presets.shades_classic,
	);

	const modsBar = multibar.create(
		totalMods,
		0,
		{ elapsed: "0:00", current: "-", t: 0, s: 0, e: 0 },
		{
			format:
				`${chalk.bold("Mods")} ${chalk.cyan("{bar}")} ${chalk.bold("{percentage}%")} | {value}/{total} | ` +
				`${chalk.green("T:{t}")} ${chalk.gray("S:{s}")} ${chalk.red("E:{e}")} | ` +
				`${chalk.gray("{elapsed}")} | ${chalk.white("{current}")}`,
		},
	);

	const keysBar = multibar.create(
		1,
		0,
		{ elapsed: "0:00", remaining: 0, note: "待機中" },
		{
			format:
				`${chalk.bold("Keys")} ${chalk.magenta("{bar}")} ${chalk.bold("{percentage}%")} | {value}/{total} | ` +
				`${chalk.gray("残り:{remaining}")} | ${chalk.gray("{elapsed}")} | ${chalk.white("{note}")}`,
		},
	);

	return {
		update: (patch: Record<string, unknown>) => {
			const elapsed = formatDuration(performance.now() - startedAt);
			const doneMods = typeof patch.doneMods === "number" ? patch.doneMods : modsBar.getProgress();
			modsBar.update(doneMods, {
				elapsed,
				current: typeof patch.current === "string" ? patch.current : undefined,
				t: typeof patch.translated === "number" ? patch.translated : undefined,
				s: typeof patch.skipped === "number" ? patch.skipped : undefined,
				e: typeof patch.errors === "number" ? patch.errors : undefined,
			});

			if (typeof patch.keyTotal === "number") keysBar.setTotal(Math.max(1, patch.keyTotal));
			if (typeof patch.keyDone === "number") {
				keysBar.update(patch.keyDone, {
					remaining: Math.max(0, (keysBar.getTotal() ?? 1) - patch.keyDone),
					elapsed,
					note: typeof patch.keyNote === "string" ? patch.keyNote : undefined,
				});
			} else if (typeof patch.keyNote === "string") {
				keysBar.update(keysBar.getProgress(), { note: patch.keyNote });
			}
		},
		log: (line: string) => multibar.log(line),
		finish: async (line?: string) => {
			if (line) multibar.log(line);
			multibar.stop();
		},
		requestAbort: () => {
			aborted = true;
		},
		isAborted: () => aborted,
		stop: () => {
			try {
				multibar.stop();
			} catch {
				// ignore
			}
		},
	};
}

type PlanTask = {
	jarPath: string;
	jarName: string;
	namespace: string;
	srcPath: string;
	dstPath: string;
};

async function buildPlan(
	opts: Pick<CliOptions, "jars" | "source" | "target" | "repairBrokenTargetInJar" | "backupJars">,
): Promise<{
	tasksByJar: Map<string, PlanTask[]>;
	total: number;
	skippedInJar: number;
	planErrors: number;
	brokenTargetFound: number;
	repairedTarget: number;
	backupCreated: number;
	repairErrors: number;
}> {
	const tasksByJar = new Map<string, PlanTask[]>();
	let total = 0;
	let skippedInJar = 0;
	let planErrors = 0;
	let brokenTargetFound = 0;
	let repairedTarget = 0;
	let backupCreated = 0;
	let repairErrors = 0;

	for (const jarPath of opts.jars) {
		try {
			const zip = await loadJarZip(jarPath);
			const namespaces = listAssetNamespaces(zip);
			const jarName = path.basename(jarPath);
			let modified = false;
			let backupDone = false;
			for (const ns of namespaces) {
				const srcPath = `assets/${ns}/lang/${opts.source}.json`;
				const dstPath = `assets/${ns}/lang/${opts.target}.json`;
				if (!zipHasFile(zip, srcPath)) continue;
				if (zipHasFile(zip, dstPath)) {
					// target language exists in jar => usually skip.
					// BUT: if it's broken JSON, treat it as "not supported" and (optionally) remove from the jar.
					let isBroken = false;
					try {
						const dstText = await readZipText(zip, dstPath);
						parseJsoncObject(dstText, `${jarPath}:${dstPath}`);
					} catch {
						isBroken = true;
						brokenTargetFound++;
					}

					if (!isBroken) {
						skippedInJar++;
						continue;
					}

					if (opts.repairBrokenTargetInJar) {
						try {
							if (opts.backupJars && !backupDone) {
								const backupPath = `${jarPath}.modtranslate.bak`;
								if (!(await Bun.file(backupPath).exists())) {
									await Bun.write(backupPath, await Bun.file(jarPath).arrayBuffer());
									backupCreated++;
								}
								backupDone = true;
							}
							removeZipFile(zip, dstPath);
							modified = true;
							repairedTarget++;
						} catch {
							repairErrors++;
							// Even if repair fails, we still plan translation into the resource pack.
						}
					}
					// If broken (and removed or not), fall through and plan translation.
				}

				const t: PlanTask = { jarPath, jarName, namespace: ns, srcPath, dstPath };
				const arr = tasksByJar.get(jarPath) ?? [];
				arr.push(t);
				tasksByJar.set(jarPath, arr);
				total++;
			}

			if (modified) {
				try {
					await saveJarZip(zip, jarPath);
				} catch {
					repairErrors++;
				}
			}
		} catch {
			planErrors++;
		}
	}

	// stable order
	for (const [k, arr] of tasksByJar) {
		arr.sort((a, b) => a.namespace.localeCompare(b.namespace));
		tasksByJar.set(k, arr);
	}

	return { tasksByJar, total, skippedInJar, planErrors, brokenTargetFound, repairedTarget, backupCreated, repairErrors };
}

function parseArgs(argv: string[]): Partial<CliOptions> {
	// Minimal arg parser:
	// --dir <path> --out <path> --source en_us --target ja_jp --yes --jar <file> (repeatable)
	const out: Partial<CliOptions> = {};
	const jars: string[] = [];

	const readValue = (i: number) => {
		const v = argv[i + 1];
		if (!v) throw new Error(`Missing value for ${argv[i]}`);
		return v;
	};

	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (!a) continue;

		if (a === "--yes" || a === "-y") {
			out.yes = true;
			continue;
		}
		if (a === "--dir") {
			out.dir = readValue(i);
			i++;
			continue;
		}
		if (a === "--out") {
			out.outDir = readValue(i);
			i++;
			continue;
		}
		if (a === "--source") {
			out.source = readValue(i);
			i++;
			continue;
		}
		if (a === "--target") {
			out.target = readValue(i);
			i++;
			continue;
		}
		if (a === "--jar") {
			jars.push(readValue(i));
			i++;
			continue;
		}
		if (a === "--repair-broken-target-in-jar") {
			out.repairBrokenTargetInJar = true;
			continue;
		}
		if (a === "--no-jar-backup") {
			out.backupJars = false;
			continue;
		}

		// --key=value style
		if (a.startsWith("--") && a.includes("=")) {
			const [k, v] = a.split("=", 2);
			if (v === undefined || v.length === 0) continue;
			switch (k) {
				case "--dir":
					out.dir = v;
					break;
				case "--out":
					out.outDir = v;
					break;
				case "--source":
					out.source = v;
					break;
				case "--target":
					out.target = v;
					break;
				case "--jar":
					jars.push(v);
					break;
				case "--repair-broken-target-in-jar":
					out.repairBrokenTargetInJar = v === "1" || v.toLowerCase() === "true";
					break;
				case "--no-jar-backup":
					out.backupJars = !(v === "1" || v.toLowerCase() === "true");
					break;
			}
		}
	}

	if (jars.length > 0) out.jars = jars;
	return out;
}

async function promptMissingOptions(partial: Partial<CliOptions>): Promise<CliOptions> {
	const baseDir = partial.dir ?? process.cwd();

	// 1) First prompt: basics (dir/source/target/outDir/yes)
	const first = await inquirer.prompt([
		{
			type: "input",
			name: "dir",
			message: "対象ディレクトリ（jarが置いてある場所）",
			default: baseDir,
			when: () => !partial.dir,
		},
		{
			type: "select",
			name: "sourcePreset",
			message: "翻訳元（Minecraft言語）",
			default: () => (partial.source ? normalizeMcLangFileStem(partial.source) : "en_us"),
			choices: [...COMMON_MC_LANGS.map((v) => ({ name: v, value: v })), { name: "カスタム入力…", value: "__custom__" }],
			when: () => !partial.source,
		},
		{
			type: "input",
			name: "sourceCustom",
			message: "翻訳元（カスタム）例: en_us",
			filter: (v: string) => normalizeMcLangFileStem(v),
			when: (a: any) => !partial.source && a.sourcePreset === "__custom__",
			validate: (v: string) => (v.trim().length > 0 ? true : "入力してください"),
		},
		{
			type: "select",
			name: "targetPreset",
			message: "翻訳先（Minecraft言語）",
			default: () => (partial.target ? normalizeMcLangFileStem(partial.target) : "ja_jp"),
			choices: (a: any) => {
				const src = normalizeMcLangFileStem(String(a.sourceCustom ?? a.sourcePreset ?? partial.source ?? "en_us"));
				const base = COMMON_MC_LANGS.filter((v) => v !== src).map((v) => ({ name: v, value: v }));
				return [...base, { name: "カスタム入力…", value: "__custom__" }];
			},
			when: () => !partial.target,
		},
		{
			type: "input",
			name: "targetCustom",
			message: "翻訳先（カスタム）例: ja_jp",
			filter: (v: string) => normalizeMcLangFileStem(v),
			when: (a: any) => !partial.target && a.targetPreset === "__custom__",
			validate: (v: string) => (v.trim().length > 0 ? true : "入力してください"),
		},
		{
			type: "input",
			name: "outDir",
			message: "出力先（resourcepackフォルダ）",
			default: (a: any) => {
				const base = String(a.dir ?? baseDir);
				return partial.outDir ?? `${base}/ModTranslateResourcePack`;
			},
			when: () => !partial.outDir,
		},
		{
			type: "confirm",
			name: "yes",
			message: "実行しますか？",
			default: true,
			when: () => !partial.yes,
		},
		{
			type: "confirm",
			name: "repairBrokenTargetInJar",
			message:
				"jar内に既に翻訳先(lang)がある場合、JSONが破損していたら削除して翻訳し直しますか？（Modファイルを書き換えます）",
			default: false,
			when: () => partial.repairBrokenTargetInJar === undefined,
		},
		{
			type: "confirm",
			name: "backupJars",
			message: "書き換え前に .modtranslate.bak を作成しますか？",
			default: true,
			when: (a: any) =>
				(partial.backupJars === undefined) && Boolean(a.repairBrokenTargetInJar ?? partial.repairBrokenTargetInJar),
		},
	]);

	const dir = String(first.dir ?? partial.dir ?? baseDir);
	const source = normalizeMcLangFileStem(
		String(first.sourceCustom ?? first.sourcePreset ?? partial.source ?? "en_us"),
	);
	const target = normalizeMcLangFileStem(
		String(first.targetCustom ?? first.targetPreset ?? partial.target ?? "ja_jp"),
	);
	const outDir = String(first.outDir ?? partial.outDir ?? `${dir}/ModTranslateResourcePack`);
	const yes = Boolean(first.yes ?? partial.yes ?? false);
	const repairBrokenTargetInJar = Boolean(
		first.repairBrokenTargetInJar ?? partial.repairBrokenTargetInJar ?? false,
	);
	const backupJars = Boolean(first.backupJars ?? partial.backupJars ?? true);

	// 2) Second prompt: jar selection or manual jar path input
	let jars: string[] = partial.jars ? [...partial.jars] : [];
	if (jars.length === 0) {
		const jarFiles = await listJarFiles(dir);

		if (jarFiles.length > 0) {
			const pick = await inquirer.prompt([
				{
					type: "checkbox",
					name: "jars",
					message: "翻訳したい jar を選択",
					choices: jarFiles.map((p) => ({ name: p.name, value: p.absPath })),
					validate: (v: string[]) => (v.length > 0 ? true : "最低1つ選んでください"),
				},
			]);
			jars = (pick.jars ?? []).map(String);
		} else {
			const manual = await inquirer.prompt([
				{
					type: "input",
					name: "jarPaths",
					message:
						"このフォルダに .jar が見つかりません。翻訳したい jar のパスを入力（複数は ; 区切り）",
					validate: async (input: string) => {
						const parts = input
							.split(";")
							.map((s) => s.trim())
							.filter(Boolean);
						if (parts.length === 0) return "jarパスを1つ以上入力してください";
						for (const p of parts) {
							const abs = path.isAbsolute(p) ? p : path.resolve(dir, p);
							if (!abs.toLowerCase().endsWith(".jar")) return `拡張子 .jar ではありません: ${p}`;
							const ok = await Bun.file(abs).exists();
							if (!ok) return `見つかりません: ${abs}`;
						}
						return true;
					},
				},
			]);

			jars = String(manual.jarPaths)
				.split(";")
				.map((s) => s.trim())
				.filter(Boolean)
				.map((p) => (path.isAbsolute(p) ? p : path.resolve(dir, p)));
		}
	}

	return { dir, outDir, source, target, jars, yes, repairBrokenTargetInJar, backupJars };
}

async function main() {
	try {
		printHeader();

		const partial = parseArgs(process.argv.slice(2));
		const opts = await promptMissingOptions(partial);

		if (!opts.yes) {
			console.log(chalk.yellow("中断しました。"));
			return;
		}

		const sourceGoogle = toGoogleLang(opts.source);
		const targetGoogle = toGoogleLang(opts.target);

		const translator = createTranslator({ source: sourceGoogle, target: targetGoogle });
		await ensureResourcePackBase(opts.outDir);

		console.log(
			chalk.gray("\n設定:"),
			JSON.stringify(
				{
					dir: opts.dir,
					outDir: opts.outDir,
					source: opts.source,
					target: opts.target,
					jars: opts.jars.length,
					repairBrokenTargetInJar: opts.repairBrokenTargetInJar,
					backupJars: opts.backupJars,
					provider: translator.provider,
					concurrency: Bun.env.TRANSLATE_CONCURRENCY ?? "(default)",
				},
				null,
				2,
			),
		);

		const startedAt = performance.now();
		const plan = await buildPlan({
			jars: opts.jars,
			source: opts.source,
			target: opts.target,
			repairBrokenTargetInJar: opts.repairBrokenTargetInJar,
			backupJars: opts.backupJars,
		});
		if (plan.total === 0) {
			console.log(chalk.yellow("\n翻訳対象が見つかりませんでした（enファイルが無い/既にjar内に翻訳がある可能性）"));
			return;
		}

		let translatedMods = 0;
		let skippedMods = 0;
		let errors = 0;
		let doneMods = 0;

		let ui: RunUi | undefined;
		const onSigint = () => {
			// If Ink run screen is active, request abort and keep UI.
			if (ui) {
				ui.requestAbort();
				ui.log("ABORT: Ctrl+C");
				process.exitCode = 130;
				return;
			}
			console.log(chalk.yellow("\n中断しました。"));
			process.exitCode = 130;
		};
		process.once("SIGINT", onSigint);

		// Processing UI:
		// - Default: terminal-kit full-screen UI (TTY only)
		// - Fallback: cli-progress (non-TTY or MODTRANSLATE_RUN_UI=cli)
		const runUi = (Bun.env.MODTRANSLATE_RUN_UI ?? "term").toLowerCase();
		const isTty = Boolean(process.stdout.isTTY);
		if (runUi !== "cli" && isTty) {
			const init: TermRunScreenStats = {
				totalMods: plan.total,
				doneMods: 0,
				translated: 0,
				skipped: 0,
				errors: 0,
				current: "-",
				keyTotal: 1,
				keyDone: 0,
				keyNote:
					`対象Mod:${plan.total} / jar内翻訳有り除外:${plan.skippedInJar} / ` +
					`破損${opts.target}:${plan.brokenTargetFound} 修復:${plan.repairedTarget} ` +
					`/ 事前スキャンエラー:${plan.planErrors} 修復エラー:${plan.repairErrors}`,
			};
			const screen = createRunScreenAnsi(init);
			ui = {
				update: screen.update as any,
				log: screen.log,
				finish: async (line?: string) => {
					await screen.finish(line);
				},
				requestAbort: screen.requestAbort,
				isAborted: screen.isAborted,
				stop: screen.stop,
			};
			ui.log(
				`対象Mod: ${plan.total} / jar内翻訳有り除外: ${plan.skippedInJar} / ` +
					`破損${opts.target}: ${plan.brokenTargetFound} 修復: ${plan.repairedTarget} ` +
					`/ 事前スキャンエラー: ${plan.planErrors} 修復エラー: ${plan.repairErrors}`,
			);
		} else {
			ui = createCliRunUi(plan.total);
			ui.log(
				chalk.gray(
					`対象Mod: ${plan.total} / jar内翻訳有り除外: ${plan.skippedInJar} / ` +
						`破損${opts.target}: ${plan.brokenTargetFound} 修復: ${plan.repairedTarget} ` +
						`/ 事前スキャンエラー: ${plan.planErrors} 修復エラー: ${plan.repairErrors}`,
				),
			);
		}

		for (const [jarPath, tasks] of plan.tasksByJar) {
			let zip;
			try {
				zip = await loadJarZip(jarPath);
			} catch (e) {
				// If a jar fails to load, mark all its planned tasks as errors and advance.
				errors += tasks.length;
				doneMods += tasks.length;
				ui?.update({
					doneMods,
					translated: translatedMods,
					skipped: skippedMods,
					errors,
					current: `${path.basename(jarPath)} (jar読込失敗)`,
					keyTotal: 1,
					keyDone: 0,
					keyNote: "jar読込失敗",
				});
				ui?.log(`ERR jar読込失敗: ${jarPath} (${String(e)})`);
				continue;
			}

			for (const task of tasks) {
				if (ui?.isAborted()) break;
				const taskStart = performance.now();
				const currentLabel = `${task.jarName} :: ${task.namespace}`;
				ui?.update({
					doneMods,
					totalMods: plan.total,
					translated: translatedMods,
					skipped: skippedMods,
					errors,
					current: currentLabel,
					keyTotal: 1,
					keyDone: 0,
					keyNote: "準備中",
				});

				try {
					if (!zipHasFile(zip, task.srcPath)) {
						skippedMods++;
						doneMods++;
						ui?.update({
							doneMods,
							translated: translatedMods,
							skipped: skippedMods,
							errors,
							current: currentLabel,
							keyTotal: 1,
							keyDone: 1,
							keyNote: "ソース無し(スキップ)",
						});
						continue;
					}

					// Read source JSON
					const srcText = await readZipText(zip, task.srcPath);
					const data = parseJsoncObject(srcText, `${task.jarPath}:${task.srcPath}`);

					// Load existing output translation if present
					const outLangPath = path.join(opts.outDir, "assets", task.namespace, "lang", `${opts.target}.json`);
					let existingTarget: Record<string, unknown> | undefined;
					if (await Bun.file(outLangPath).exists()) {
						try {
							const existingText = await Bun.file(outLangPath).text();
							existingTarget = parseJsoncObject(existingText, outLangPath);
						} catch {
							existingTarget = undefined;
						}
					}

					const translated: Record<string, unknown> = existingTarget ? { ...existingTarget } : {};
					const entries = Object.entries(data);

					const stringKeys: string[] = [];
					const stringValues: string[] = [];
					let missingKey = false;
					for (const [k, v] of entries) {
						if (typeof v === "string") {
							const existing = existingTarget?.[k];
							if (existingTarget && !(k in existingTarget)) missingKey = true;
							if (typeof existing === "string" && existing.trim().length > 0 && existing !== v) {
								translated[k] = existing;
								continue;
							}
							stringKeys.push(k);
							stringValues.push(v);
						} else {
							translated[k] = v;
						}
					}

					if (existingTarget && !missingKey && stringValues.length === 0) {
						skippedMods++;
						doneMods++;
						ui?.update({
							doneMods,
							translated: translatedMods,
							skipped: skippedMods,
							errors,
							current: currentLabel,
							keyTotal: 1,
							keyDone: 1,
							keyNote: "差分なし（既存再利用）",
						});
						ui?.log(`SKIP ${currentLabel} (${formatDuration(performance.now() - taskStart)})`);
						continue;
					}

					if (stringValues.length > 0) {
						const totalStrings = stringKeys.length;
						const existingCount = totalStrings - stringValues.length;
						const note = existingTarget
							? `差分翻訳 ${stringValues.length}件（既存 ${existingCount}件 再利用）`
							: `翻訳 ${stringValues.length}件`;

						ui?.update({
							keyTotal: stringValues.length,
							keyDone: 0,
							keyNote: note,
						});

						const results = await translator.translateMany(stringValues, {
							onProgress: (done, total) => {
								ui?.update({
									keyTotal: Math.max(1, total),
									keyDone: done,
									keyNote: note,
								});
								if (ui?.isAborted()) {
									ui.requestAbort();
								}
							},
						});

						for (let i = 0; i < stringKeys.length; i++) {
							const k = stringKeys[i];
							const v = results[i];
							if (k !== undefined) translated[k] = v;
						}
					} else {
						ui?.update({
							keyTotal: 1,
							keyDone: 1,
							keyNote: "更新（翻訳不要）",
						});
					}

					await writeLangFile({
						outDir: opts.outDir,
						namespace: task.namespace,
						langFileStem: opts.target,
						json: translated,
					});

					translatedMods++;
					doneMods++;
					ui?.update({
						doneMods,
						translated: translatedMods,
						skipped: skippedMods,
						errors,
						current: currentLabel,
						keyDone: stringValues.length > 0 ? stringValues.length : 1,
					});
					ui?.log(`OK   ${currentLabel} (${formatDuration(performance.now() - taskStart)})`);
				} catch (e) {
					errors++;
					doneMods++;
					ui?.update({
						doneMods,
						translated: translatedMods,
						skipped: skippedMods,
						errors,
						current: currentLabel,
						keyTotal: 1,
						keyDone: 0,
						keyNote: "エラー",
					});
					ui?.log(`ERR  ${currentLabel}: ${String(e)}`);
				}
			}
		}

		if (ui) {
			await ui.finish(ui.isAborted() ? "中断しました" : "完了しました");
			ui.stop();
		}
		process.removeListener("SIGINT", onSigint);
		console.log(
			chalk.bold("\n完了"),
			chalk.gray(
				`(対象: ${plan.total} / 翻訳: ${translatedMods} / スキップ: ${skippedMods} / エラー: ${errors}) ` +
				`時間: ${formatDuration(performance.now() - startedAt)} → ${opts.outDir}`,
			),
		);
	} catch (e) {
		// Inquirer throws ExitPromptError on Ctrl+C.
		const msg = String(e);
		if (msg.includes("ExitPromptError") || msg.includes("SIGINT")) {
			console.log(chalk.yellow("中断しました。"));
			return;
		}
		throw e;
	}
}

await main();
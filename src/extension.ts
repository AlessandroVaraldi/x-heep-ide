import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFile, spawn } from 'child_process';
import { createHash } from 'crypto';
import {
	findExecutables, findToolchains, findPythonEnvs, findConda, condaSetup, venvSetup,
	xheepVerilatorVersion, verilatorPrefix, verilatorInstallCommand,
	toolchainUrl, toolchainInstallCommand, packageInstallCommand, devcontainerJson,
} from './tools';
import { Mode, MODES, JTAG_ADAPTERS, Options, Simulator, SIM_MODEL, buildCommand, simCommand, simModelBuildCommand, FLASH_COMMAND, mcuGenCommand, simSummary, incrementalBuildCommand, verilatorRunCommand,
	DEBUG_BUILD_ROOT, debugModelBuildCommand, debugSimCommand, openocdCommand,
	XHEEP_GIT, XHEEP_COMMIT_URL, isCommit, cloneCommand, writeMain, projectSource, configTemplate } from './xheep';

let extensionDir: string;
let extensionId: string;
let folder: vscode.WorkspaceFolder;
/** The X-HEEP repo: the workspace itself, or `x-heep/` inside a software project. */
let root: string;
/** The sw/ dir holding the user's apps: X-HEEP's own, or the software project's. */
let swRoot: string;
let state: vscode.Memento;
let output: vscode.OutputChannel;
let uart: vscode.OutputChannel;
let appItem: vscode.StatusBarItem;
let modeItem: vscode.StatusBarItem;
let configItem: vscode.StatusBarItem;
let apps: AppsProvider;

const cfg = () => vscode.workspace.getConfiguration('xheep');
const examplesDir = () => path.join(root, 'sw', 'applications');
const userAppsDir = () => path.join(swRoot, 'applications');
const isProject = () => swRoot !== path.join(root, 'sw');
const currentApp = () => state.get<string>('app', 'hello_world');
const currentMode = () => state.get<Mode>('mode', 'sim');

function listDir(dir: string): string[] {
	if (!fs.existsSync(dir)) {
		return [];
	}
	return fs.readdirSync(dir, { withFileTypes: true })
		.filter(d => d.isDirectory())
		.map(d => d.name)
		.sort();
}

function userApps(): string[] {
	return isProject() ? listDir(userAppsDir()) : listDir(examplesDir()).filter(a => !examples.has(a));
}

function exampleApps(): string[] {
	return isProject() ? listDir(examplesDir()) : listDir(examplesDir()).filter(a => examples.has(a));
}

/** In a software project, a user app shadows an X-HEEP example with the same name. */
const isProjectApp = (app: string) => isProject() && fs.existsSync(path.join(userAppsDir(), app));
const appDir = (app: string) => path.join(isProjectApp(app) ? userAppsDir() : examplesDir(), app);

// shortcut: an app counts as an example while git tracks it, so a committed user app moves to Examples.
let examples = new Set<string>();

function loadExamples(): Promise<void> {
	return new Promise(resolve => execFile('git', ['ls-files', '-z', '--', 'sw/applications'], { cwd: root }, (err, out) => {
		examples = new Set(err ? [] : out.split('\0').map(f => f.split('/')[2]).filter(Boolean));
		resolve();
	}));
}

const expandHome = (p: string) => p.replace(/^~(?=$|\/)/, os.homedir());

function toolchain(): string {
	return expandHome(cfg().get<string>('riscvToolchain') || process.env.RISCV_XHEEP || '~/.riscv');
}

/** A tool's executable: its `xheep.<key>` setting (the executable or its folder), else `name` from PATH. */
function toolExe(key: string, name: string): string {
	const p = expandHome(cfg().get<string>(key, ''));
	if (!p) {
		return name;
	}
	return fs.existsSync(p) && fs.statSync(p).isDirectory() ? path.join(p, name) : p;
}

/** Folders of the tools set in the settings, put first in PATH for every command the extension runs. */
function toolDirs(): string[] {
	return [toolExe('verilatorPath', 'verilator'), toolExe('openocdPath', 'openocd'), toolExe('picocomPath', 'picocom')]
		.filter(p => path.isAbsolute(p)).map(p => path.dirname(p)).concat(path.join(toolchain(), 'bin'));
}

function findTool(suffix: string): string | undefined {
	const bin = path.join(toolchain(), 'bin');
	const name = fs.existsSync(bin) ? fs.readdirSync(bin).find(f => f.endsWith(suffix)) : undefined;
	return name && path.join(bin, name);
}

function simBuilt(sim: Simulator): boolean {
	const build = path.join(root, 'build');
	return fs.existsSync(build) && fs.readdirSync(build).some(d =>
		d.startsWith('openhwgroup.org_systems_core-v-mini-mcu_') && fs.existsSync(path.join(build, d, SIM_MODEL[sim])));
}

function options(project = currentApp(), mode = currentMode()): Options {
	const simulator = cfg().get<Simulator>('simulator', 'verilator');
	return {
		project,
		mode,
		compiler: cfg().get<string>('compiler', 'gcc'),
		board: cfg().get<string>('fpgaBoard', 'pynq-z2'),
		simulator,
		source: isProjectApp(project) ? projectSource(root, swRoot) : undefined,
	};
}

// --- Platform configuration -------------------------------------------------

const projectDir = () => folder.uri.fsPath;
const userConfigsDir = () => path.join(projectDir(), 'configs');

/** The active config: `xheep.mcuConfig`, looked up in the project first, then in X-HEEP. */
function configPath(): string {
	const c = cfg().get<string>('mcuConfig', 'configs/general.py');
	return [projectDir(), root].map(d => path.resolve(d, c)).find(fs.existsSync) ?? path.resolve(root, c);
}

function listConfigs(dir: string): string[] {
	return fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => /\.(py|hjson)$/.test(f) && !f.startsWith('pad_cfg')).sort() : [];
}

// shortcut: only the config file itself is hashed, so edits to files it imports or an X-HEEP update need "Regenerate Platform".
function platformStamp(): string {
	const file = configPath();
	const hash = fs.existsSync(file) ? createHash('sha1').update(fs.readFileSync(file)).digest('hex') : 'missing';
	return `${file}@${hash}`;
}

const platformReady = () => state.get('platformStamp') === platformStamp()
	&& fs.existsSync(path.join(root, 'hw', 'core-v-mini-mcu', 'include', 'core_v_mini_mcu_pkg.sv'));
const modelKey = (sim: Simulator) => `modelStamp.${sim}`;
const modelReady = (sim: Simulator) => simBuilt(sim) && state.get(modelKey(sim)) === state.get('platformStamp');

/** Runs a task in the background with a status bar spinner; the terminal only shows up when it fails. */
async function runQuiet(title: string, task: vscode.Task, silent: boolean): Promise<boolean> {
	if (silent) {
		task.presentationOptions = { reveal: vscode.TaskRevealKind.Silent, clear: true };
	}
	const code = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title }, () => runTask(task));
	if (code !== 0) {
		vscode.window.showErrorMessage(`X-HEEP: ${title} failed.`, 'Show Log').then(pick =>
			pick && vscode.window.terminals.find(t => t.name.includes(task.name))?.show());
	}
	return code === 0;
}

async function generatePlatform(silent: boolean): Promise<boolean> {
	const stamp = platformStamp();
	const config = configPath();
	const ok = await runQuiet(`Generating platform (${path.basename(config)})`, makeTask('mcu-gen', mcuGenCommand(config)), silent);
	if (ok) {
		await state.update('platformStamp', stamp);
	}
	return ok;
}

async function buildModel(sim: Simulator, silent: boolean): Promise<boolean> {
	const ok = await runQuiet(`Building ${sim} model`, makeTask(`Build ${sim} model`, simModelBuildCommand(sim)), silent);
	if (ok) {
		await state.update(modelKey(sim), state.get('platformStamp'));
	}
	return ok;
}

/** Regenerates the platform and, for simulation, the RTL model when they are out of date. */
async function prepare(o: Options): Promise<boolean> {
	if (!platformReady() && !await generatePlatform(true)) {
		return false;
	}
	return o.mode !== 'sim' || modelReady(o.simulator) || buildModel(o.simulator, true);
}

async function selectConfig() {
	const item = (file: string, dir: string) => ({ label: path.basename(file).replace(/\.(py|hjson)$/, ''), description: file, file: path.join(dir, file) });
	const mine = listConfigs(userConfigsDir()).map(f => item(f, userConfigsDir()));
	const xheep = isProject() ? listConfigs(path.join(root, 'configs')).map(f => item(f, path.join(root, 'configs'))) : [];
	const picked = await vscode.window.showQuickPick([
		...(isProject() ? [{ label: 'Project', kind: vscode.QuickPickItemKind.Separator } as const] : []), ...mine,
		...(xheep.length ? [{ label: 'X-HEEP', kind: vscode.QuickPickItemKind.Separator } as const] : []), ...xheep,
		{ label: '$(add) New Configuration…', file: '' },
	], { placeHolder: `Platform configuration (now: ${path.relative(projectDir(), configPath())})` });
	if (!picked || !('file' in picked)) {
		return;
	}
	if (!picked.file) {
		return newConfig();
	}
	await cfg().update('mcuConfig', path.relative(projectDir(), picked.file), vscode.ConfigurationTarget.Workspace);
}

async function newConfig() {
	const name = await vscode.window.showInputBox({
		prompt: 'Name of the new platform configuration',
		placeHolder: 'my_soc',
		validateInput: v => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(v) ? 'Use letters, digits and _ (a Python module name)'
			: fs.existsSync(path.join(userConfigsDir(), `${v}.py`)) ? 'This configuration already exists' : undefined,
	});
	if (!name) {
		return;
	}
	const file = path.join(userConfigsDir(), `${name}.py`);
	fs.mkdirSync(userConfigsDir(), { recursive: true });
	fs.writeFileSync(file, configTemplate(root, name));
	await cfg().update('mcuConfig', path.relative(projectDir(), file), vscode.ConfigurationTarget.Workspace);
	await vscode.window.showTextDocument(vscode.Uri.file(file));
}

// --- Running make ---------------------------------------------------------

function withEnvSetup(cmd: string): string {
	const setup = cfg().get<string>('envSetup', '').trim();
	return setup ? `${setup} && ${cmd}` : cmd;
}

function taskEnv(): Record<string, string> {
	// CMake reads this env var, so every app build drops sw/build/compile_commands.json for IntelliSense.
	return {
		RISCV_XHEEP: toolchain(), CMAKE_EXPORT_COMPILE_COMMANDS: 'ON',
		PATH: [...toolDirs(), process.env.PATH ?? ''].join(path.delimiter),
	};
}

function makeTask(name: string, cmd: string, rawShell = false, env: Record<string, string> = {}): vscode.Task {
	const exec = new vscode.ShellExecution(rawShell ? cmd : withEnvSetup(cmd), {
		executable: '/bin/bash', shellArgs: ['-c'], cwd: root, env: { ...taskEnv(), ...env },
	});
	const task = new vscode.Task({ type: 'xheep', command: cmd }, folder, name, 'X-HEEP', exec, ['$xheep-gcc']);
	task.presentationOptions = { reveal: vscode.TaskRevealKind.Always, clear: true };
	return task;
}

async function runTask(task: vscode.Task): Promise<number | undefined> {
	const execution = await vscode.tasks.executeTask(task);
	return new Promise(resolve => {
		const sub = vscode.tasks.onDidEndTaskProcess(e => {
			if (e.execution === execution) {
				sub.dispose();
				resolve(e.exitCode);
			}
		});
	});
}

function sh(cmd: string, setup = true): Promise<boolean> {
	return new Promise(resolve => execFile('/bin/bash', ['-c', setup ? withEnvSetup(cmd) : cmd],
		{ cwd: root, env: { ...process.env, ...taskEnv() } }, err => resolve(!err)));
}

// --- Commands -------------------------------------------------------------

async function selectApp(app?: string) {
	app ??= await vscode.window.showQuickPick([...userApps(), ...exampleApps()], { placeHolder: 'Select the X-HEEP application' });
	if (!app) {
		return;
	}
	await state.update('app', app);
	refreshUi();
	const main = ['main.c', 'main.cpp', 'main.S'].map(f => path.join(appDir(app), f)).find(fs.existsSync);
	if (main) {
		vscode.window.showTextDocument(vscode.Uri.file(main), { preview: true });
	}
}

async function newApp() {
	const name = await vscode.window.showInputBox({
		prompt: 'Name of the new application',
		placeHolder: 'my_app',
		validateInput: v => !/^[A-Za-z0-9_-]+$/.test(v) ? 'Use letters, digits, _ or -'
			: [...userApps(), ...exampleApps()].includes(v) ? 'An application with this name already exists' : undefined,
	});
	if (!name) {
		return;
	}
	writeMain(path.join(userAppsDir(), name), name);
	await selectApp(name);
}

async function newFile(app = currentApp()) {
	const dir = appDir(app);
	const name = await vscode.window.showInputBox({
		prompt: `New file in ${app}`,
		placeHolder: 'utils.c',
		validateInput: v => !/^[\w.-]+(\/[\w.-]+)*$/.test(v) ? 'Use letters, digits, _ . - and / for folders'
			: fs.existsSync(path.join(dir, v)) ? 'This file already exists' : undefined,
	});
	if (!name) {
		return;
	}
	// The X-HEEP CMake picks up every source and header under the app folder, so no build file to edit.
	const file = path.join(dir, name);
	const guard = path.basename(name).toUpperCase().replace(/\W/g, '_') + '_';
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, name.endsWith('.h') ? `#ifndef ${guard}\n#define ${guard}\n\n#endif // ${guard}\n` : '');
	await vscode.window.showTextDocument(vscode.Uri.file(file));
}


function addToGitignore(dir: string, entry: string) {
	const file = path.join(dir, '.gitignore');
	const lines = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n') : [];
	if (!lines.includes(entry)) {
		fs.appendFileSync(file, `${lines.length && lines[lines.length - 1] !== '' ? '\n' : ''}${entry}\n`);
	}
}

/** Runs a bash script outside the task system (works with no folder open), logging to the X-HEEP output. */
function runLogged(title: string, script: string, cwd: string): Thenable<number | null> {
	output.show(true);
	output.appendLine(`$ ${script}`);
	return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title }, () => new Promise(resolve => {
		const proc = spawn('/bin/bash', ['-c', script], { cwd });
		proc.stdout.on('data', d => output.append(d.toString()));
		proc.stderr.on('data', d => output.append(d.toString()));
		proc.on('close', resolve);
	}));
}

/** The last X-HEEP commit the extension is known to work with: the live pin on GitHub, else the bundled one. */
async function pinnedCommit(): Promise<string | undefined> {
	try {
		const live = (await (await fetch(XHEEP_COMMIT_URL, { signal: AbortSignal.timeout(5000) })).text()).trim();
		if (isCommit(live)) {
			return live;
		}
	} catch { /* offline: fall back to the pin shipped with the extension */ }
	try {
		const bundled = fs.readFileSync(path.join(extensionDir, 'XHEEP_COMMIT'), 'utf8').trim();
		return isCommit(bundled) ? bundled : undefined;
	} catch {
		return undefined;
	}
}

/** Sets up a software project in a chosen folder: own apps in sw/applications, X-HEEP in x-heep/. */
async function newProject() {
	const ws = vscode.workspace.workspaceFolders?.[0];
	const dir = (await vscode.window.showOpenDialog({
		canSelectFolders: true, canSelectFiles: false, defaultUri: ws?.uri,
		title: 'Folder of the new software project (an empty one is fine)', openLabel: 'Create Project Here',
	}))?.[0]?.fsPath;
	if (!dir) {
		return;
	}
	if (isXheep(dir)) {
		vscode.window.showErrorMessage('This is the X-HEEP repository itself: pick the folder of your own project.');
		return;
	}
	const xheep = path.join(dir, 'x-heep');
	if (fs.existsSync(xheep) && !isXheep(xheep)) {
		vscode.window.showErrorMessage(`${xheep} exists but is not an X-HEEP repository. Remove it and run this command again.`);
		return;
	}
	if (!fs.existsSync(xheep)) {
		const how = await vscode.window.showQuickPick([
			{ id: 'submodule', label: 'Add X-HEEP as a git submodule', detail: `Clones ${XHEEP_GIT} into x-heep/ at the latest commit this extension is tested with` },
			{ id: 'link', label: 'Link an existing X-HEEP clone', detail: 'Symlinks x-heep/ to a clone you already have (kept out of git)' },
		], { placeHolder: 'Where does X-HEEP come from?' });
		if (!how) {
			return;
		}
		if (how.id === 'link') {
			const src = (await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, openLabel: 'Use this X-HEEP' }))?.[0]?.fsPath;
			if (!src) {
				return;
			}
			if (!fs.existsSync(path.join(src, 'util', 'xheep_gen', 'mcu_gen.py'))) {
				vscode.window.showErrorMessage(`${src} is not an X-HEEP repository.`);
				return;
			}
			fs.symlinkSync(src, xheep);
			addToGitignore(dir, 'x-heep');
		} else {
			const commit = await pinnedCommit();
			output.appendLine(commit ? `X-HEEP commit known to work with this extension: ${commit}` : 'No pinned X-HEEP commit found: using the latest main.');
			const code = await runLogged('Cloning X-HEEP…', cloneCommand(XHEEP_GIT, commit), dir);
			if (code !== 0) {
				vscode.window.showErrorMessage('Cloning X-HEEP failed, see the X-HEEP output. Nothing was left behind: you can retry.');
				return;
			}
		}
	}
	const hello = path.join(dir, 'sw', 'applications', 'hello');
	if (!fs.existsSync(hello)) {
		writeMain(hello, 'hello');
	}
	// Recreated before each build (see projectSource), so it stays out of git.
	addToGitignore(dir, 'sw/device');
	await (ws?.uri.fsPath === dir
		? vscode.commands.executeCommand('workbench.action.reloadWindow')
		: vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(dir)));
}

const currentAdapter = () => JTAG_ADAPTERS.find(a => a.config === cfg().get<string>('openocdConfig'));

async function selectMode() {
	// JTAG debugging is listed once per adapter, since each needs its own OpenOCD config.
	type Item = vscode.QuickPickItem & { id: Mode; config?: string };
	const items = (Object.keys(MODES) as Mode[]).flatMap((id): Item[] => id !== 'fpga-jtag'
		? [{ id, label: MODES[id].label, detail: MODES[id].detail }]
		: JTAG_ADAPTERS.map(a => ({ id, label: `${MODES[id].label} — ${a.label}`, detail: a.detail, config: a.config })));
	const picked = await vscode.window.showQuickPick(items, { placeHolder: 'How should the app run?' });
	if (picked) {
		if (picked.config) {
			await cfg().update('openocdConfig', picked.config, vscode.ConfigurationTarget.Workspace);
		}
		await state.update('mode', picked.id);
		refreshUi();
	}
}

type BuildStatus = 'ok' | 'fail' | 'running';
const buildStatus = (app: string) => state.get<Record<string, BuildStatus>>('buildStatus', {})[app];

async function setBuildStatus(app: string, status: BuildStatus) {
	await state.update('buildStatus', { ...state.get('buildStatus', {}), [app]: status });
	refreshUi();
}

function listFiles(dir: string): string[] {
	return fs.existsSync(dir) ? fs.readdirSync(dir, { recursive: true, withFileTypes: true })
		.filter(e => e.isFile()).map(e => path.relative(dir, path.join(e.parentPath, e.name))).sort() : [];
}

/** Compiles the app quietly: the result shows as a tick or cross, the terminal only on failure. */
async function compile(o: Options): Promise<boolean> {
	await setBuildStatus(o.project, 'running');
	// CMake globs the sources at configure time, so a new or removed file needs the full `make app`.
	const key = JSON.stringify([buildCommand(o), state.get('platformStamp'), listFiles(appDir(o.project))]);
	const jobs = os.cpus().length;
	const incremental = state.get('lastBuildKey') === key && fs.existsSync(path.join(root, 'sw', 'build', 'Makefile'));
	const task = incremental
		? makeTask(`Build ${o.project}`, incrementalBuildCommand(jobs), true)
		: makeTask(`Build ${o.project}`, buildCommand(o), false, { MAKEFLAGS: `-j${jobs}` });
	const ok = await runQuiet(`Build of ${o.project}`, task, true);
	// A compile error keeps the configured tree valid; a failed full build may leave it half done.
	await state.update('lastBuildKey', ok || incremental ? key : undefined);
	await setBuildStatus(o.project, ok ? 'ok' : 'fail');
	return ok;
}

async function build(app?: string) {
	const o = options(app);
	// No RTL model needed just to compile.
	return await prepare({ ...o, mode: o.mode === 'sim' ? 'fpga-jtag' : o.mode }) && compile(o);
}

function simDir(sim: Simulator): string | undefined {
	const build = path.join(root, 'build');
	const core = fs.existsSync(build) ? fs.readdirSync(build).find(d => d.startsWith('openhwgroup.org_systems_core-v-mini-mcu_')) : undefined;
	return core && path.join(build, core, path.dirname(SIM_MODEL[sim]));
}

/** Streams a simulator's UART log into "X-HEEP UART" under a header; the returned function flushes and stops. */
function tailUart(uartLog: string, title: string): () => void {
	fs.rmSync(uartLog, { force: true }); // else the first poll would replay the previous run
	let offset = 0;
	const pump = () => {
		const size = fs.existsSync(uartLog) ? fs.statSync(uartLog).size : 0;
		if (size > offset) {
			const fd = fs.openSync(uartLog, 'r');
			const buf = Buffer.alloc(size - offset);
			fs.readSync(fd, buf, 0, buf.length, offset);
			fs.closeSync(fd);
			uart.append(buf.toString());
			offset = size;
		}
	};
	uart.appendLine(`── ${title} · ${new Date().toLocaleTimeString()} ${'─'.repeat(30)}`);
	uart.show(true);
	const poll = setInterval(pump, 250);
	return () => { clearInterval(poll); pump(); };
}

/** Starts a shell command in its own process group with its output logged to "X-HEEP". */
function startJob(cmd: string, cwd: string, env: Record<string, string> = {}) {
	output.appendLine(`\n$ ${cmd}`);
	const proc = spawn('/bin/bash', ['-c', cmd], { cwd, env: { ...process.env, ...taskEnv(), ...env }, detached: true });
	let log = '';
	const onData = (d: Buffer) => { log += d; output.append(d.toString()); };
	proc.stdout.on('data', onData);
	proc.stderr.on('data', onData);
	return {
		log: () => log,
		done: new Promise<number | null>(resolve => proc.on('close', resolve)),
		// detached: the negative pid also stops what the shell started (make, fusesoc, the simulator).
		kill: () => { try { process.kill(-proc.pid!, 'SIGTERM'); } catch { /* already gone */ } },
	};
}

/** Polls `test` until it holds (true), the timeout passes or `abort` settles (false). */
async function waitUntil(test: () => boolean, timeoutMs: number, abort?: Promise<unknown>): Promise<boolean> {
	let aborted = false;
	abort?.then(() => { aborted = true; });
	for (const end = Date.now() + timeoutMs; Date.now() < end && !aborted; await new Promise(r => setTimeout(r, 250))) {
		if (test()) {
			return true;
		}
	}
	return test();
}

/** Runs the simulation in the background: its log goes to "X-HEEP", only the app's UART to "X-HEEP UART". */
async function simulate(o: Options) {
	// shortcut: Questasim's UART log is assumed to be uart0.log in sim-modelsim/ like Verilator's, unverified.
	const dir = simDir(o.simulator);
	const stopUart = tailUart(dir ? path.join(dir, 'uart0.log') : '', o.project);
	const job = startJob(o.simulator === 'verilator' && dir ? verilatorRunCommand(dir) : withEnvSetup(simCommand(o)), root);
	const code = await vscode.window.withProgress(
		{ location: vscode.ProgressLocation.Notification, title: `Simulating ${o.project}…`, cancellable: true },
		(_progress, token) => { token.onCancellationRequested(job.kill); return job.done; });
	stopUart();
	const summary = simSummary(job.log());
	uart.appendLine(code === null ? '── stopped' : `── ${summary.ok ? '✓' : '✗'} ${summary.text}`);
	uart.appendLine('');
	if (code !== null && summary.text === 'simulation failed') {
		vscode.window.showErrorMessage(`X-HEEP: simulation of ${o.project} failed.`, 'Show Log').then(pick => pick && output.show());
	}
}

async function run(app?: string) {
	const o = options(app);
	if (o.mode === 'fpga-jtag') {
		return debug(app);
	}
	if (!await prepare(o) || !await compile(o)) {
		return;
	}
	switch (o.mode) {
		case 'sim':
			await simulate(o);
			break;
		case 'fpga-flash':
			if (await runTask(makeTask(`Flash ${o.project}`, FLASH_COMMAND)) === 0) {
				await openSerial();
				vscode.window.showInformationMessage('Flash programmed. Press RESET on the FPGA to start the program.');
			}
			break;
	}
}

const debugSimDir = () => path.join(root, DEBUG_BUILD_ROOT, 'sim-verilator');
const debugModelReady = () => fs.existsSync(path.join(debugSimDir(), 'Vtestharness'))
	&& state.get('modelStamp.debug') === state.get('platformStamp');

async function buildDebugModel(): Promise<boolean> {
	const ok = await runQuiet('Building verilator debug model', makeTask('Build debug model', debugModelBuildCommand()), true);
	if (ok) {
		await state.update('modelStamp.debug', state.get('platformStamp'));
	}
	return ok;
}

/**
 * Debugs the app with the VS Code debugger (cppdbg + GDB) through OpenOCD: on the simulated X-HEEP
 * in Simulation mode, on the FPGA board otherwise. The extension owns OpenOCD and the simulator,
 * and stops them when the debug session ends.
 */
async function debug(app?: string) {
	const sim = currentMode() === 'sim';
	const o = options(app, sim ? 'sim' : 'fpga-jtag');
	const gdb = findTool('-elf-gdb');
	if (!gdb) {
		vscode.window.showErrorMessage(`No *-elf-gdb found in ${toolchain()}/bin. Set "xheep.riscvToolchain".`);
		return;
	}
	// Platform only: simulation debugging uses its own JTAG-enabled model, not the regular one.
	if (!await prepare({ ...o, mode: 'fpga-jtag' }) || !await compile(o) || (sim && !debugModelReady() && !await buildDebugModel())) {
		return;
	}
	const openocd = toolExe('openocdPath', 'openocd');
	const jobs: ReturnType<typeof startJob>[] = [];
	let stopUart = () => { };
	let cancelled = false;
	const cleanup = () => { jobs.forEach(j => j.kill()); stopUart(); };
	const ready = await vscode.window.withProgress({
		location: vscode.ProgressLocation.Notification, cancellable: true,
		title: sim ? `Starting the simulated X-HEEP for ${o.project}…` : 'Connecting to the FPGA over JTAG…',
	}, async (_progress, token) => {
		token.onCancellationRequested(() => { cancelled = true; cleanup(); });
		if (!sim) {
			await openSerial();
			const ocd = startJob(openocdCommand(openocd, path.join(root, cfg().get<string>('openocdConfig', 'tb/core-v-mini-mcu-pynq-z2-bscan.cfg'))), root);
			jobs.push(ocd);
			if (!await waitUntil(() => ocd.log().includes('Listening on port 3333'), 20_000, ocd.done)) {
				return false;
			}
			// OpenOCD opens the GDB port even when it cannot reach the RISC-V debug module.
			if (/examination failed|dtmcontrol is 0/.test(ocd.log())) {
				const bscan = cfg().get<string>('openocdConfig', '').includes('bscan');
				vscode.window.showErrorMessage('X-HEEP: OpenOCD sees the JTAG chain but not the X-HEEP debug module. ' + (bscan
					? 'The BSCAN config needs a bitstream built with FUSESOC_FLAGS=--flag=use_bscane_xilinx; with an external JTAG adapter, pick it in the run mode.'
					: 'Check that the bitstream is loaded and the JTAG adapter is wired to X-HEEP.'), 'Show Log').then(pick => pick && output.show());
				cancelled = true; // error already reported
				return false;
			}
			return true;
		}
		const dir = debugSimDir();
		stopUart = tailUart(path.join(dir, 'uart0.log'), `${o.project} · debug`);
		const simJob = startJob(debugSimCommand(dir, path.join(root, 'sw', 'build', 'main.hex')), dir);
		jobs.push(simJob);
		// The bitbang server accepts a single client, so wait for its banner instead of probing the port.
		if (!await waitUntil(() => simJob.log().includes('Listening on port 4567'), 30_000, simJob.done)) {
			return false;
		}
		const ocdLog = path.join(dir, 'openocd.log'); // tb/core-v-mini-mcu.cfg logs there, not to stderr
		fs.rmSync(ocdLog, { force: true });
		const ocd = startJob(openocdCommand(openocd, path.join(root, 'tb', 'core-v-mini-mcu.cfg')), dir, { JTAG_VPI_PORT: '4567' });
		jobs.push(ocd);
		return waitUntil(() => fs.existsSync(ocdLog) && fs.readFileSync(ocdLog, 'utf8').includes('Listening on port 3333'), 60_000, ocd.done);
	});
	if (!ready) {
		cleanup();
		if (!cancelled) {
			vscode.window.showErrorMessage('X-HEEP: OpenOCD did not come up.', 'Show Log').then(pick => pick && output.show());
		}
		return;
	}
	const name = `X-HEEP: ${o.project}`;
	const ended = vscode.debug.onDidTerminateDebugSession(s => {
		if (s.name === name) {
			ended.dispose();
			cleanup();
			if (sim) {
				const summary = simSummary(jobs[0].log());
				uart.appendLine(`── ${summary.text === 'simulation failed' ? 'debug session ended' : `${summary.ok ? '✓' : '✗'} ${summary.text}`}`);
				uart.appendLine('');
			}
		}
	});
	// When the program exits the simulator (or OpenOCD) stops: end the session with it.
	jobs[0].done.then(() => {
		const session = vscode.debug.activeDebugSession;
		if (session?.name === name) {
			vscode.debug.stopDebugging(session);
		}
	});
	const started = await vscode.debug.startDebugging(folder, {
		name,
		type: 'cppdbg',
		request: 'launch',
		program: path.join(root, 'sw', 'build', 'main.elf'),
		cwd: root,
		MIMode: 'gdb',
		miDebuggerPath: gdb,
		// cppdbg fails on GDB's "riscv:rv32" ('arch' out of range); any 32-bit value skips that detection.
		targetArchitecture: 'arm',
		// Exactly sw/gdbInit: cppdbg's own remote launch uses plain `target remote` and its own steps.
		// Breakpoints set in the editor are inserted after these commands, before the final continue.
		setupCommands: [{ text: 'set remotetimeout 2000' }],
		// With custom launch commands cppdbg no longer loads the ELF into GDB itself, hence `file`.
		customLaunchSetupCommands: [
			{ text: `file '${path.join(root, 'sw', 'build', 'main.elf')}'` },
			{ text: 'target extended-remote :3333' },
			{ text: 'load' },
		],
		launchCompleteCommand: 'exec-continue',
	});
	if (!started) {
		ended.dispose();
		cleanup();
	}
}

function serialCandidates(): string[] {
	const byId = '/dev/serial/by-id';
	return [
		...(fs.existsSync(byId) ? fs.readdirSync(byId).map(f => path.join(byId, f)) : []),
		...fs.readdirSync('/dev').filter(f => /^(tty\.usbserial|ttyUSB)/.test(f)).map(f => path.join('/dev', f)),
	];
}

async function openSerial() {
	let port = cfg().get<string>('serialPort', '');
	if (!port || !fs.existsSync(port)) {
		const candidates = serialCandidates();
		if (!candidates.length) {
			vscode.window.showWarningMessage('No serial port found: connect the FPGA UART or set "xheep.serialPort".');
			return;
		}
		port = await vscode.window.showQuickPick(candidates, { placeHolder: 'Select the X-HEEP UART port' }) ?? '';
		if (!port) {
			return;
		}
		await cfg().update('serialPort', port, vscode.ConfigurationTarget.Workspace);
	}
	vscode.window.terminals.find(t => t.name === 'X-HEEP UART')?.dispose();
	vscode.window.createTerminal({
		name: 'X-HEEP UART',
		shellPath: toolExe('picocomPath', 'picocom'),
		shellArgs: ['-b', String(cfg().get<number>('serialBaud', 9600)), '-r', '-l', '--imap', 'lfcrlf', port],
	}).show(true);
}

async function buildSimModel() {
	const sim = cfg().get<Simulator>('simulator', 'verilator');
	return (platformReady() || await generatePlatform(false)) && buildModel(sim, false);
}

function mcuGen() {
	return generatePlatform(false);
}

// --- Environment check ----------------------------------------------------

type ToolId = 'python' | 'toolchain' | 'verilator' | 'openocd' | 'picocom';
interface Check { id: ToolId; label: string; usedBy: string; ok: boolean }

async function runChecks(): Promise<Check[]> {
	const questa = cfg().get<Simulator>('simulator', 'verilator') === 'questasim';
	return [
		{ id: 'python', label: 'Python environment (fusesoc)', usedBy: 'every build', ok: await sh('command -v fusesoc') },
		{ id: 'toolchain', label: 'RISC-V toolchain', usedBy: 'compiling and debugging apps', ok: !!findTool('-elf-gcc') && !!findTool('-elf-gdb') },
		{ id: 'verilator', label: questa ? 'Questasim (vsim)' : 'Verilator', usedBy: 'Simulation', ok: await sh(`command -v ${questa ? 'vsim' : 'verilator'}`, false) },
		{ id: 'openocd', label: 'OpenOCD', usedBy: 'debugging', ok: await sh(`command -v '${toolExe('openocdPath', 'openocd')}'`, false) },
		{ id: 'picocom', label: 'picocom', usedBy: 'the FPGA serial output', ok: await sh(`command -v '${toolExe('picocomPath', 'picocom')}'`, false) },
	];
}

async function checkEnv(quiet = false) {
	const checks = await runChecks();
	output.appendLine(`X-HEEP environment check (${root})`);
	checks.forEach(c => output.appendLine(`${c.ok ? '✓' : '✗'} ${c.label} (${c.usedBy})`));
	output.appendLine(`  Platform config: ${configPath()} (${platformReady() ? 'generated' : 'regenerated on the next build'})`);
	const missing = checks.filter(c => !c.ok);
	if (!missing.length) {
		if (!quiet) {
			vscode.window.showInformationMessage('X-HEEP: all tools found.');
		}
		return;
	}
	const choice = await vscode.window.showWarningMessage(`X-HEEP: not found: ${missing.map(c => c.label).join(', ')}.`, 'Fix…', 'Show details');
	if (choice === 'Fix…') {
		await fixTools();
	} else if (choice === 'Show details') {
		output.show();
	}
}

/** Walks the user through each missing tool until all are found or they give up. */
async function fixTools() {
	for (; ;) {
		const missing = (await runChecks()).filter(c => !c.ok);
		if (!missing.length) {
			vscode.window.showInformationMessage('X-HEEP: all tools found.');
			return;
		}
		const picked = await vscode.window.showQuickPick(missing.map(c => ({ label: c.label, detail: `Needed for ${c.usedBy}`, c })),
			{ placeHolder: 'X-HEEP: which tool do you want to set up?' });
		if (!picked || !await fixTool(picked.c)) {
			return;
		}
	}
}

const setGlobal = (key: string, value: string) => cfg().update(key, value, vscode.ConfigurationTarget.Global);

/** Offers the found candidates, a manual pick, an install and the container for one tool; false if dismissed. */
async function fixTool(c: Check): Promise<boolean> {
	type Action = vscode.QuickPickItem & { run?: () => Thenable<unknown> | Promise<unknown> };
	const sep = (label: string): Action => ({ label, kind: vscode.QuickPickItemKind.Separator });
	const settingFor: Partial<Record<ToolId, string>> = { verilator: 'verilatorPath', openocd: 'openocdPath', picocom: 'picocomPath' };
	let found: Action[] = [];
	let locate: Action | undefined;
	let install: { cmd: string; done: () => Thenable<unknown>; note?: string } | undefined;

	if (c.id === 'python') {
		found = findPythonEnvs(root).map(e => ({ label: e.label, detail: e.setup, run: () => setGlobal('envSetup', e.setup) }));
		locate = {
			label: '$(terminal) Use a setup script or command…', detail: 'e.g. a lab script or "module load", run before every command',
			run: async () => {
				const v = await vscode.window.showInputBox({ prompt: 'Shell command that activates the X-HEEP Python environment', value: cfg().get('envSetup') });
				return v !== undefined && setGlobal('envSetup', v);
			},
		};
		const conda = findConda();
		install = conda
			? { cmd: `PATH='${path.dirname(conda)}':$PATH make conda`, done: () => setGlobal('envSetup', condaSetup(conda, 'x-heep')) }
			: { cmd: 'make venv', done: () => setGlobal('envSetup', venvSetup(path.join(root, '.venv'))) };
	} else if (c.id === 'toolchain') {
		found = findToolchains().map(d => ({ label: d, run: () => setGlobal('riscvToolchain', d) }));
		locate = {
			label: '$(folder-opened) Locate…', detail: 'The folder that contains bin/riscv32-…-elf-gcc',
			run: async () => {
				const d = (await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, openLabel: 'Use this toolchain' }))?.[0]?.fsPath;
				return d && setGlobal('riscvToolchain', d);
			},
		};
		const url = toolchainUrl();
		const dest = path.join(os.homedir(), '.riscv');
		if (url) {
			install = { cmd: toolchainInstallCommand(url, dest), done: () => setGlobal('riscvToolchain', dest) };
		}
	} else if (settingFor[c.id]) {
		const key = settingFor[c.id]!;
		found = findExecutables(c.id).map(p => ({ label: p, run: () => setGlobal(key, p) }));
		locate = {
			label: '$(folder-opened) Locate…', detail: `The ${c.id} executable`,
			run: async () => {
				const p = (await vscode.window.showOpenDialog({ canSelectFiles: true, openLabel: `Use this ${c.id}` }))?.[0]?.fsPath;
				return p && setGlobal(key, p);
			},
		};
		if (c.id === 'verilator') {
			// Package managers ship other versions: build the one X-HEEP uses, as its setup guide does.
			const version = xheepVerilatorVersion(root);
			install = {
				cmd: verilatorInstallCommand(version),
				done: () => setGlobal(key, path.join(verilatorPrefix(version), 'bin', 'verilator')),
				note: `Builds Verilator ${version} from source into ${verilatorPrefix(version)}, as in X-HEEP's setup guide. `
					+ 'Needs git, autoconf, flex, bison and g++ 13 or newer, and takes several minutes.',
			};
		} else {
			const cmd = packageInstallCommand(c.id);
			if (cmd) {
				install = { cmd, done: () => Promise.resolve() };
			}
		}
	}

	const items: Action[] = [
		...(found.length ? [sep('Found on this computer'), ...found] : []),
		sep('Other options'),
		...(locate ? [locate] : []),
		...(install ? [{
			label: '$(cloud-download) Install…', detail: install.cmd,
			run: async () => {
				const ok = await vscode.window.showWarningMessage(`Install ${c.label}?`, { modal: true, detail: `${install!.note ? install!.note + '\n\n' : ''}This runs in a terminal:\n${install!.cmd}` }, 'Install');
				if (ok && await runTask(makeTask(`Install ${c.label}`, install!.cmd, true)) === 0) {
					await install!.done();
				}
			},
		}] : []),
		{ label: '$(vm) Use the X-HEEP container instead…', detail: 'All tools preinstalled, via Docker or WSL; simulation only, no FPGA', run: openInContainer },
	];
	const action = await vscode.window.showQuickPick(items, { placeHolder: `${c.label}: how do you want to set it up?` });
	if (!action?.run) {
		return false;
	}
	await action.run();
	return true;
}

// --- Containers -------------------------------------------------------------

async function ensureExtension(id: string, why: string): Promise<boolean> {
	if (vscode.extensions.getExtension(id)) {
		return true;
	}
	if (await vscode.window.showInformationMessage(`${why} needs the ${id} extension.`, 'Install') !== 'Install') {
		return false;
	}
	await vscode.commands.executeCommand('workbench.extensions.installExtension', id);
	return true;
}

/**
 * Reopens the project where the X-HEEP tools are ready: WSL (Windows) or a Dev Container on X-HEEP's
 * toolchain image. VS Code and this extension then run in Linux, unchanged.
 */
async function openInContainer() {
	const ws = vscode.workspace.workspaceFolders?.[0];
	if (!ws) {
		return;
	}
	const wsl = process.platform === 'win32' && (await vscode.window.showQuickPick([
		{ label: 'WSL', detail: 'Reopen in your Linux distribution; then set the tools up there (recommended)', wsl: true },
		{ label: 'Docker container', detail: 'X-HEEP toolchain image, everything preinstalled; needs Docker Desktop', wsl: false },
	], { placeHolder: 'Where should X-HEEP run?' }))?.wsl;
	if (wsl === undefined && process.platform === 'win32') {
		return;
	}
	if (wsl) {
		return await ensureExtension('ms-vscode-remote.remote-wsl', 'Opening in WSL')
			&& vscode.commands.executeCommand('remote-wsl.reopenInWSL');
	}
	const file = path.join(ws.uri.fsPath, '.devcontainer', 'devcontainer.json');
	if (!fs.existsSync(file)) {
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, devcontainerJson(extensionId));
	}
	return await ensureExtension('ms-vscode-remote.remote-containers', 'The X-HEEP container')
		&& vscode.commands.executeCommand('remote-containers.reopenInContainer');
}

// --- UI ---------------------------------------------------------------------

// Tree elements are app names, plus these two (\0 cannot appear in a folder name).
const EXAMPLES = '\0examples';
const NEW_APP = '\0new';

class AppsProvider implements vscode.TreeDataProvider<string> {
	private exampleCount = 0;
	private emitter = new vscode.EventEmitter<void>();
	readonly onDidChangeTreeData = this.emitter.event;
	refresh() { loadExamples().then(() => this.emitter.fire()); }
	getChildren(el?: string) {
		if (el === EXAMPLES) {
			return exampleApps();
		}
		if (el) {
			return [];
		}
		this.exampleCount = exampleApps().length;
		const mine = userApps();
		return [...(mine.length ? mine : [NEW_APP]), EXAMPLES];
	}
	getTreeItem(app: string) {
		if (app === EXAMPLES) {
			const item = new vscode.TreeItem('Examples', vscode.TreeItemCollapsibleState.Collapsed);
			item.iconPath = new vscode.ThemeIcon('library');
			item.description = String(this.exampleCount);
			return item;
		}
		if (app === NEW_APP) {
			const item = new vscode.TreeItem('New application…');
			item.iconPath = new vscode.ThemeIcon('add');
			item.command = { command: 'xheep.newApp', title: 'New Application' };
			return item;
		}
		const item = new vscode.TreeItem(app);
		item.contextValue = userApps().includes(app) ? 'userApp' : 'app';
		item.iconPath = statusIcon(buildStatus(app));
		if (app === currentApp()) {
			item.label = { label: app, highlights: [[0, app.length]] };
			item.description = 'active';
		}
		item.tooltip = appDir(app);
		item.command = { command: 'xheep.selectApp', title: 'Select App', arguments: [app] };
		return item;
	}
}

function statusIcon(status?: BuildStatus): vscode.ThemeIcon {
	switch (status) {
		case 'ok': return new vscode.ThemeIcon('pass', new vscode.ThemeColor('testing.iconPassed'));
		case 'fail': return new vscode.ThemeIcon('error', new vscode.ThemeColor('testing.iconFailed'));
		case 'running': return new vscode.ThemeIcon('sync~spin');
		default: return new vscode.ThemeIcon('circle-large-outline');
	}
}

function refreshUi() {
	apps.refresh();
	const status = buildStatus(currentApp());
	const icon = { ok: '$(pass)', fail: '$(error)', running: '$(sync~spin)' }[status ?? 'ok'] ?? '$(chip)';
	appItem.text = `${status ? icon : '$(chip)'} ${currentApp()}`;
	appItem.tooltip = `X-HEEP application${status && status !== 'running' ? ` (last build: ${status === 'ok' ? 'succeeded' : 'failed'})` : ''}`;
	appItem.backgroundColor = status === 'fail' ? new vscode.ThemeColor('statusBarItem.errorBackground') : undefined;
	modeItem.text = `$(target) ${MODES[currentMode()].label}${currentMode() === 'fpga-jtag' && currentAdapter() ? ` (${currentAdapter()!.label})` : ''}`;
	configItem.text = `$(settings) ${path.basename(configPath()).replace(/\.(py|hjson)$/, '')}`;
}

function setupIntelliSense() {
	const rel = path.relative(folder.uri.fsPath, root).split(path.sep).join('/');
	const xheepDir = `\${workspaceFolder}${rel ? '/' + rel : ''}`;
	const defaults: [string, string, unknown][] = [
		['C_Cpp.default', 'compileCommands', `${xheepDir}/sw/build/compile_commands.json`],
		// Lets Pylance resolve the X-HEEP classes imported by the platform configs.
		['python.analysis', 'extraPaths', [`${xheepDir}/util/xheep_gen`]],
	];
	for (const [section, key, value] of defaults) {
		const conf = vscode.workspace.getConfiguration(section, folder.uri);
		if (conf.inspect(key)?.workspaceValue === undefined) {
			conf.update(key, value, vscode.ConfigurationTarget.Workspace);
		}
	}
}

const isXheep = (dir: string) => fs.existsSync(path.join(dir, 'util', 'xheep_gen', 'mcu_gen.py'));

export function activate(context: vscode.ExtensionContext) {
	extensionDir = context.extensionPath;
	extensionId = context.extension.id;
	output = vscode.window.createOutputChannel('X-HEEP');
	uart = vscode.window.createOutputChannel('X-HEEP UART');
	context.subscriptions.push(output, uart,
		vscode.commands.registerCommand('xheep.newProject', newProject),
		vscode.commands.registerCommand('xheep.openInContainer', openInContainer));
	// Either X-HEEP itself is open, or a software project with X-HEEP in x-heep/.
	const found = vscode.workspace.workspaceFolders?.find(f => isXheep(f.uri.fsPath) || isXheep(path.join(f.uri.fsPath, 'x-heep')));
	if (!found) {
		// Empty view, so its welcome content (package.json viewsWelcome) offers to create a project.
		context.subscriptions.push(vscode.window.registerTreeDataProvider('xheep.apps', { getChildren: () => [], getTreeItem: (x: string) => new vscode.TreeItem(x) }));
		return;
	}
	folder = found;
	// The tools and every command assume Linux or macOS: on Windows, offer WSL or the container.
	if (process.platform === 'win32') {
		vscode.window.showWarningMessage('X-HEEP needs Linux tools: reopen this folder in WSL or in the X-HEEP container.', 'Reopen…')
			.then(pick => pick && openInContainer());
		return;
	}
	const dir = folder.uri.fsPath;
	root = isXheep(dir) ? dir : path.join(dir, 'x-heep');
	swRoot = path.join(dir, 'sw');
	vscode.commands.executeCommand('setContext', 'xheep.active', true);
	state = context.workspaceState;
	// A build cut short by closing the window would otherwise spin forever.
	state.update('buildStatus', Object.fromEntries(Object.entries(state.get<Record<string, BuildStatus>>('buildStatus', {})).filter(([, v]) => v !== 'running')));
	apps = new AppsProvider();

	appItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 10);
	appItem.command = 'xheep.selectApp';
	appItem.tooltip = 'X-HEEP application';
	modeItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 9);
	modeItem.command = 'xheep.selectMode';
	modeItem.tooltip = 'X-HEEP run mode';
	configItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 7);
	configItem.command = 'xheep.selectConfig';
	configItem.tooltip = 'X-HEEP platform configuration';
	const runItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 8);
	runItem.command = 'xheep.run';
	runItem.text = '$(play)';
	runItem.tooltip = 'Run the X-HEEP application';
	[appItem, modeItem, runItem, configItem].forEach(i => i.show());

	const watchers = [...new Set([examplesDir(), userAppsDir()])].map(d => vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(d, '*')));
	watchers.forEach(w => { w.onDidCreate(() => apps.refresh()); w.onDidDelete(() => apps.refresh()); });

	context.subscriptions.push(
		appItem, modeItem, runItem, configItem, ...watchers,
		vscode.workspace.onDidChangeConfiguration(e => e.affectsConfiguration('xheep.mcuConfig') && refreshUi()),
		vscode.window.registerTreeDataProvider('xheep.apps', apps),
		vscode.commands.registerCommand('xheep.selectApp', selectApp),
		vscode.commands.registerCommand('xheep.selectMode', selectMode),
		vscode.commands.registerCommand('xheep.newApp', newApp),
		vscode.commands.registerCommand('xheep.newFile', newFile),
		vscode.commands.registerCommand('xheep.openDocs', () => vscode.env.openExternal(vscode.Uri.parse('https://x-heep.readthedocs.io/en/latest/'))),
		vscode.commands.registerCommand('xheep.build', build),
		vscode.commands.registerCommand('xheep.run', run),
		vscode.commands.registerCommand('xheep.debug', debug),
		vscode.commands.registerCommand('xheep.openSerial', openSerial),
		vscode.commands.registerCommand('xheep.mcuGen', mcuGen),
		vscode.commands.registerCommand('xheep.selectConfig', selectConfig),
		vscode.commands.registerCommand('xheep.newConfig', newConfig),
		vscode.commands.registerCommand('xheep.buildSimModel', buildSimModel),
		vscode.commands.registerCommand('xheep.checkEnv', () => checkEnv()),
		vscode.commands.registerCommand('xheep.fixTools', fixTools),
		vscode.commands.registerCommand('xheep.refreshApps', () => apps.refresh()),
	);

	refreshUi();
	setupIntelliSense();
	checkEnv(true);
}

export function deactivate() {}

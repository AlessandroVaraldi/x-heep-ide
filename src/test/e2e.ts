// End-to-end check against a real X-HEEP: runs, in the same order and with the same helpers, what the
// extension does for a software project: clone X-HEEP as a submodule, create an app and a platform
// configuration, mcu-gen, full and incremental build, Verilator model, simulation.
// Needs the X-HEEP tools on PATH (CI uses the x-heep-toolchain image). Usage: node out/test/e2e.js [workdir]
import * as assert from 'assert';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
	Options, XHEEP_GIT, cloneCommand, writeMain, projectSource, configTemplate, mcuGenCommand, buildCommand,
	incrementalBuildCommand, simModelBuildCommand, verilatorRunCommand, simSummary,
} from '../xheep';

const project = path.resolve(process.argv[2] ?? fs.mkdtempSync(path.join(os.tmpdir(), 'xheep-e2e-')));
const xheep = path.join(project, 'x-heep');
const sw = path.join(project, 'sw');
const app = 'e2e_app';
// As the extension's tasks: every build also writes compile_commands.json for IntelliSense.
const env = { ...process.env, CMAKE_EXPORT_COMPILE_COMMANDS: 'ON', MAKEFLAGS: `-j${os.cpus().length}` };

function run(cmd: string, cwd: string, capture = false): string {
	console.log(`\n::group::$ ${cmd}`);
	try {
		return execSync(cmd, { cwd, env, shell: '/bin/bash', encoding: 'utf8', maxBuffer: 1 << 28, stdio: capture ? 'pipe' : 'inherit' }) ?? '';
	} finally {
		console.log('::endgroup::');
	}
}

fs.mkdirSync(project, { recursive: true });
console.log(`Project: ${project}`);

// XHEEP_COMMIT: the commit to test (the pinned one in CI, X-HEEP's latest main in the canary).
const commit = process.env.XHEEP_COMMIT || undefined;
run(cloneCommand(process.env.XHEEP_URL ?? XHEEP_GIT, commit), project);
assert.ok(fs.existsSync(path.join(xheep, 'util', 'xheep_gen', 'mcu_gen.py')), 'X-HEEP was not cloned into x-heep/');
if (commit) {
	assert.strictEqual(run('git rev-parse HEAD', xheep, true).trim(), commit, 'x-heep/ is not at the requested commit');
}

writeMain(path.join(sw, 'applications', app), app);
const config = path.join(project, 'configs', 'e2e.py');
fs.mkdirSync(path.dirname(config), { recursive: true });
fs.writeFileSync(config, configTemplate(xheep, 'e2e'));

run(mcuGenCommand(config), xheep);

const o: Options = { project: app, mode: 'sim', compiler: 'gcc', board: 'pynq-z2', simulator: 'verilator', source: projectSource(xheep, sw) };
run(buildCommand(o), xheep);
const build = path.join(xheep, 'sw', 'build');
assert.ok(fs.existsSync(path.join(build, 'main.hex')), 'make app did not produce main.hex');
assert.ok(fs.readFileSync(path.join(build, 'compile_commands.json'), 'utf8').includes(`applications/${app}/main.c`),
	'compile_commands.json does not list the app');

fs.utimesSync(path.join(sw, 'applications', app, 'main.c'), new Date(), new Date());
run(incrementalBuildCommand(os.cpus().length), xheep);

run(simModelBuildCommand('verilator'), xheep);
const core = fs.readdirSync(path.join(xheep, 'build')).find(d => d.startsWith('openhwgroup.org_systems_core-v-mini-mcu_'));
assert.ok(core, 'no fusesoc build directory');
const simDir = path.join(xheep, 'build', core, 'sim-verilator');
const out = run(verilatorRunCommand(simDir), xheep, true);
console.log(out);
const summary = simSummary(out);
assert.ok(summary.ok, `simulation: ${summary.text}`);
const uart = fs.readFileSync(path.join(simDir, 'uart0.log'), 'utf8');
assert.ok(uart.includes(`Hello from ${app}!`), `unexpected UART output: ${uart}`);

console.log(`\nE2E OK: ${summary.text}, UART: ${uart.trim()}`);

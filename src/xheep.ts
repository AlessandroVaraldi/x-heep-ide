// Helpers that turn the user's choices into X-HEEP commands and files.
// Kept free of the vscode API so the unit tests and the end-to-end test (src/test/e2e.ts) share them.

import * as fs from 'fs';
import * as path from 'path';

export const XHEEP_GIT = 'https://github.com/x-heep/x-heep.git';

/**
 * The last X-HEEP commit the extension is known to work with. The X-HEEP canary workflow updates this file
 * in the extension's repo, so new projects get it without waiting for an extension release.
 */
export const XHEEP_COMMIT_URL = 'https://raw.githubusercontent.com/LuigiGiuffrida98/x-heep-ide/main/XHEEP_COMMIT';
export const isCommit = (s: string) => /^[0-9a-f]{40}$/.test(s);

/**
 * Adds X-HEEP as a shallow submodule in x-heep/, at `commit` if given;
 * on failure drops the half clone so a retry starts clean.
 */
export function cloneCommand(url = XHEEP_GIT, commit?: string): string {
	const pin = commit ? ` && git -C x-heep fetch -q --depth 1 origin ${commit} && git -C x-heep checkout -q ${commit} && git add x-heep` : '';
	return `{ [ -d .git ] || git init; } && `
		+ `{ git submodule add --progress --depth 1 ${url} x-heep && git config -f .gitmodules submodule.x-heep.shallow true${pin}; } `
		+ `|| { git rm -q --cached x-heep 2>/dev/null; rm -rf x-heep .git/modules/x-heep; exit 1; }`;
}

/** Creates <dir>/main.c with a hello world for a new app. */
export function writeMain(dir: string, name: string) {
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, 'main.c'),
		`#include <stdio.h>\n#include <stdlib.h>\n\nint main(void)\n{\n    printf("Hello from ${name}!\\n");\n    return EXIT_SUCCESS;\n}\n`);
}

/**
 * make SOURCE for apps in a software project's sw/ (relative to X-HEEP's sw/).
 * CMake only takes drivers from <SOURCE>/device, so it also links the project's sw/device to X-HEEP's.
 */
export function projectSource(xheep: string, swRoot: string): string {
	const device = path.join(swRoot, 'device');
	if (!fs.existsSync(device)) {
		fs.symlinkSync(path.relative(swRoot, path.join(xheep, 'sw', 'device')), device);
	}
	// realpath: the Makefile resolves its own location, so x-heep/ may be a symlink.
	return path.relative(fs.realpathSync(path.join(xheep, 'sw')), fs.realpathSync(swRoot));
}

/** A new platform configuration: X-HEEP's configs/general.py with Pylance-friendly imports. */
export function configTemplate(xheep: string, name: string): string {
	const findModule = (pkg: string, cls: string) => {
		const dir = path.join(xheep, 'util', 'xheep_gen', ...pkg.split('.'));
		const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f.endsWith('.py') && f !== '__init__.py') : [];
		return files.find(f => new RegExp(`^class ${cls}\\b`, 'm').test(fs.readFileSync(path.join(dir, f), 'utf8')))?.replace(/\.py$/, '');
	};
	return `# Platform configuration "${name}", started from X-HEEP configs/general.py.\n`
		+ '# Edit and save: the extension regenerates the platform before the next build.\n'
		+ explicitImports(fs.readFileSync(path.join(xheep, 'configs', 'general.py'), 'utf8'), findModule);
}

export type Mode = 'sim' | 'fpga-jtag' | 'fpga-flash';
export type Simulator = 'verilator' | 'questasim';

export const MODES: Record<Mode, { label: string; detail: string }> = {
	'sim': { label: 'Simulation', detail: 'Run the app on the RTL model (Verilator or Questasim)' },
	'fpga-jtag': { label: 'FPGA · JTAG Debug', detail: 'Load the app over JTAG and debug it with GDB' },
	'fpga-flash': { label: 'FPGA · Flash', detail: 'Program the app into the SPI flash and boot from it' },
};

/** JTAG adapters for FPGA debugging, each with its OpenOCD config in X-HEEP's tb/. */
export const JTAG_ADAPTERS = [
	{ label: 'EPFL Programmer', detail: 'External FT4232 programmer on the PMOD JTAG pins', config: 'tb/core-v-mini-mcu-esl-programmer.cfg' },
	{ label: 'On-board USB (BSCAN)', detail: 'Pynq-Z2 USB port; needs a bitstream built with FUSESOC_FLAGS=--flag=use_bscane_xilinx', config: 'tb/core-v-mini-mcu-pynq-z2-bscan.cfg' },
	{ label: 'Digilent HS2', detail: 'Digilent JTAG-HS2 cable (Nexys)', config: 'tb/core-v-mini-mcu-nexsys-hs2.cfg' },
];

export interface Options {
	project: string;
	mode: Mode;
	compiler: string;
	board: string;
	simulator: Simulator;
	/** sw dir of an app living outside X-HEEP, relative to X-HEEP's sw/ (make SOURCE). */
	source?: string;
}

export function appVars(o: Options): string {
	const target = o.mode === 'sim' ? 'sim' : o.board;
	const linker = o.mode === 'fpga-flash' ? 'flash_load' : 'on_chip';
	const source = o.source ? ` SOURCE=${o.source}` : '';
	return `PROJECT=${o.project} TARGET=${target} LINKER=${linker} COMPILER=${o.compiler}${source}`;
}

export function buildCommand(o: Options): string {
	return `make app ${appVars(o)}`;
}

/** Compiled model inside build/<fusesoc core dir>/; mcu-gen's `fusesoc --setup` creates the dirs empty. */
export const SIM_MODEL: Record<Simulator, string> = {
	verilator: 'sim-verilator/Vtestharness',
	questasim: 'sim-modelsim/work',
};

export function simModelBuildCommand(sim: Simulator): string {
	// `make <sim>-build` pipes fusesoc into tee, so its exit code is always 0: drop the old model and check it came back.
	return `rm -rf build/*/${SIM_MODEL[sim]} && make ${sim}-build && `
		+ `{ ls build/*/${SIM_MODEL[sim]} >/dev/null 2>&1 || { echo "Simulation model build failed, see buildsim.log"; exit 1; }; }`;
}

/** Recompiles only what changed in the CMake tree `make app` configured (it would wipe it and start over). */
export function incrementalBuildCommand(jobs: number): string {
	return `make -s -C sw/build -j${jobs}`;
}

/**
 * Runs the compiled Verilator model directly, the same step `make verilator-run` does after fusesoc,
 * which first spends seconds resolving cores and rerunning generators.
 */
export function verilatorRunCommand(simDir: string): string {
	return `cd '${simDir}' && ./Vtestharness +firmware=../../../sw/build/main.hex`;
}

/** Separate fusesoc build root for the JTAG-enabled model, so the regular one stays untouched. */
export const DEBUG_BUILD_ROOT = 'build/debug';

/** Builds a Verilator model with the remote bitbang JTAG server (JTAG_DPI=1) for GDB in simulation. */
export function debugModelBuildCommand(): string {
	const exe = `${DEBUG_BUILD_ROOT}/sim-verilator/Vtestharness`;
	return `rm -f ${exe} && fusesoc --cores-root . run --no-export --target=sim --tool=verilator `
		+ `--build-root ${DEBUG_BUILD_ROOT} --build openhwgroup.org:systems:core-v-mini-mcu --JTAG_DPI=1 && test -x ${exe}`;
}

/** Starts the debug model waiting for OpenOCD on port 4567; GDB then loads the firmware over JTAG. */
export function debugSimCommand(simDir: string, hex: string): string {
	return `cd '${simDir}' && ./Vtestharness +openOCD=true +firmware='${hex}'`;
}

export function openocdCommand(openocd: string, config: string): string {
	return `${openocd} -f '${config}'`;
}

/** Runs the already built firmware (sw/build/main.hex) on the RTL model. */
export function simCommand(o: Options): string {
	return `make ${o.simulator}-run`;
}

export function mcuGenCommand(config: string): string {
	return `make mcu-gen X_HEEP_CFG='${config}'`;
}

/** Programs the already built firmware into the FPGA board's SPI flash. */
export const FLASH_COMMAND = 'make flash-prog';

/** Summary of an RTL simulation from its console output, e.g. `exit 0 · 12502 cycles`. */
export function simSummary(out: string): { ok: boolean; text: string } {
	const cycles = /Simulation finished after (\d+) clock cycles/.exec(out)?.[1];
	const value = /Program Finished with value (-?\d+)/.exec(out)?.[1];
	const text = value === undefined ? 'simulation failed' : `exit ${value}${cycles ? ` · ${cycles} cycles` : ''}`;
	return { ok: value === '0', text };
}

/**
 * Rewrites `from peripherals.<pkg> import (A, B)` into one import per class from its own module.
 * X-HEEP's peripheral packages re-export classes at runtime via globals(), which Pylance cannot follow.
 * `findModule(pkg, name)` returns the module (file stem) defining class `name`, or undefined to keep it as is.
 */
export function explicitImports(src: string, findModule: (pkg: string, name: string) => string | undefined): string {
	return src.replace(/^from (peripherals\.\w+) import (\(([^)]*)\)|[^\n(]+)$/gm, (line: string, pkg: string, all: string, group?: string) => {
		const names = (group ?? all).split(',').map(n => n.trim()).filter(Boolean);
		const kept: string[] = [];
		const lines = names.flatMap(n => {
			const mod = findModule(pkg, n);
			return mod ? [`from ${pkg}.${mod} import ${n}`] : (kept.push(n), []);
		});
		return [...lines, ...(kept.length ? [`from ${pkg} import ${kept.join(', ')}`] : [])].join('\n') || line;
	});
}

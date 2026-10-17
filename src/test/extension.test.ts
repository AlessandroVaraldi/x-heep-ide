import * as assert from 'assert';
import { Options, buildCommand, simCommand, simModelBuildCommand, mcuGenCommand, explicitImports, simSummary, incrementalBuildCommand, verilatorRunCommand, debugModelBuildCommand, debugSimCommand, cloneCommand } from '../xheep';

const base: Options = { project: 'hello_world', mode: 'sim', compiler: 'gcc', board: 'pynq-z2', simulator: 'verilator' };

suite('X-HEEP make commands', () => {
	test('simulation builds for sim target with on-chip linker, then runs the hex', () => {
		assert.strictEqual(buildCommand(base), 'make app PROJECT=hello_world TARGET=sim LINKER=on_chip COMPILER=gcc');
		assert.strictEqual(simCommand({ ...base, simulator: 'questasim' }), 'make questasim-run');
	});

	test('fast paths skip the clean rebuild and fusesoc', () => {
		assert.strictEqual(incrementalBuildCommand(8), 'make -s -C sw/build -j8');
		assert.strictEqual(verilatorRunCommand('/x/build/core/sim-verilator'),
			"cd '/x/build/core/sim-verilator' && ./Vtestharness +firmware=../../../sw/build/main.hex");
	});

	test('simulation debug uses its own JTAG-enabled model', () => {
		assert.ok(debugModelBuildCommand().includes('--build-root build/debug '));
		assert.ok(debugModelBuildCommand().includes('--JTAG_DPI=1'));
		assert.strictEqual(debugSimCommand('/m', '/x/sw/build/main.hex'), "cd '/m' && ./Vtestharness +openOCD=true +firmware='/x/sw/build/main.hex'");
	});

	test('new projects clone X-HEEP at the pinned commit', () => {
		const sha = 'bf0748ac5d15a1c274a47e3a7b663e6153c34187';
		assert.ok(cloneCommand('https://x', sha).includes(`git -C x-heep fetch -q --depth 1 origin ${sha} && git -C x-heep checkout -q ${sha} && git add x-heep;`));
		assert.ok(!cloneCommand('https://x').includes('checkout'));
	});

	test('simulation summary reads the testbench output', () => {
		assert.deepStrictEqual(simSummary('Simulation finished after 12502 clock cycles\nProgram Finished with value 0\n'),
			{ ok: true, text: 'exit 0 · 12502 cycles' });
		assert.deepStrictEqual(simSummary('Program Finished with value 3\n'), { ok: false, text: 'exit 3' });
		assert.deepStrictEqual(simSummary('%Error: ...'), { ok: false, text: 'simulation failed' });
	});

	test('mcu-gen takes the config by path, also outside X-HEEP', () => {
		assert.strictEqual(mcuGenCommand('/home/me/proj/configs/my.py'), "make mcu-gen X_HEEP_CFG='/home/me/proj/configs/my.py'");
	});

	test('apps outside X-HEEP are built with SOURCE', () => {
		assert.strictEqual(buildCommand({ ...base, source: '../../sw' }),
			'make app PROJECT=hello_world TARGET=sim LINKER=on_chip COMPILER=gcc SOURCE=../../sw');
	});

	test('model build fails when the model is missing even if make exits 0', () => {
		// A stale model from a previous build must not count: it is removed first.
		const cmd = simModelBuildCommand('verilator').replace('make verilator-build', 'true');
		const dir = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'xheep-'));
		require('fs').mkdirSync(require('path').join(dir, 'build', 'core', 'sim-verilator'), { recursive: true });
		require('fs').writeFileSync(require('path').join(dir, 'build', 'core', 'sim-verilator', 'Vtestharness'), '');
		const run = require('child_process').spawnSync('/bin/bash', ['-c', cmd], { cwd: dir });
		assert.strictEqual(run.status, 1);
	});

	test('config template imports each peripheral class from its own module', () => {
		const src = 'from xheep import XHeep\nfrom peripherals.base_peripherals import (\n    SOC_ctrl,\n    Unknown,\n)\nfrom peripherals.user_peripherals import UART\n';
		const mods: Record<string, string> = { SOC_ctrl: 'SOC_ctrl', UART: 'uart' };
		assert.strictEqual(explicitImports(src, (_pkg, n) => mods[n]),
			'from xheep import XHeep\nfrom peripherals.base_peripherals.SOC_ctrl import SOC_ctrl\nfrom peripherals.base_peripherals import Unknown\n'
			+ 'from peripherals.user_peripherals.uart import UART\n');
	});

	test('JTAG debug builds for the board with on-chip linker', () => {
		assert.strictEqual(buildCommand({ ...base, mode: 'fpga-jtag', compiler: 'clang' }),
			'make app PROJECT=hello_world TARGET=pynq-z2 LINKER=on_chip COMPILER=clang');
	});

	test('flash mode builds with the flash_load linker', () => {
		assert.strictEqual(buildCommand({ ...base, mode: 'fpga-flash', board: 'nexys-a7-100t' }),
			'make app PROJECT=hello_world TARGET=nexys-a7-100t LINKER=flash_load COMPILER=gcc');
	});
});

suite('Tool discovery', () => {
	const fs = require('fs') as typeof import('fs');
	const path = require('path') as typeof import('path');
	const os = require('os') as typeof import('os');
	const tools = require('../tools') as typeof import('../tools');
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xheep-tools-'));
	const exe = (p: string) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, ''); fs.chmodSync(p, 0o755); };

	test('finds executables in globbed install dirs', () => {
		exe(path.join(tmp, 'tools', 'verilator', 'v5', 'bin', 'verilator'));
		fs.writeFileSync(path.join(tmp, 'tools', 'verilator', 'v5', 'bin', 'picocom'), ''); // not executable
		assert.deepStrictEqual(tools.findExecutables('verilator', [`${tmp}/tools/*/*/bin`]), [path.join(tmp, 'tools', 'verilator', 'v5', 'bin', 'verilator')]);
		assert.deepStrictEqual(tools.findExecutables('picocom', [`${tmp}/tools/*/*/bin`]), []);
	});

	test('finds toolchains and conda envs with fusesoc', () => {
		exe(path.join(tmp, 'riscv', 'bin', 'riscv32-corev-elf-gcc'));
		assert.deepStrictEqual(tools.findToolchains([`${tmp}/*`]), [path.join(tmp, 'riscv')]);
		exe(path.join(tmp, 'mf', 'bin', 'conda'));
		exe(path.join(tmp, 'mf', 'envs', 'x-heep', 'bin', 'fusesoc'));
		fs.mkdirSync(path.join(tmp, 'mf', 'envs', 'other'), { recursive: true });
		const envs = tools.findPythonEnvs(path.join(tmp, 'nope'), [path.join(tmp, 'mf')]);
		assert.deepStrictEqual(envs.map(e => e.setup), [tools.condaSetup(path.join(tmp, 'mf', 'bin', 'conda'), 'x-heep')]);
	});

	test('picks the Embecosm toolchain for the platform', () => {
		assert.ok(tools.toolchainUrl('darwin', 'arm64')!.endsWith('corev-gcc-macos-arm64/8/artifact/corev-openhw-gcc-macos-20240530.dmg'));
		assert.ok(tools.toolchainUrl('linux', 'x64', 'ID=ubuntu\nVERSION_ID="20.04"\n')!.includes('ubuntu2004-20240530.tar.gz'));
		assert.ok(tools.toolchainUrl('linux', 'x64', 'ID="rocky"\nVERSION_ID="9.3"\n')!.includes('corev-gcc-rocky9/48/'));
		assert.ok(tools.toolchainUrl('linux', 'x64', 'ID=debian\nVERSION_ID="12"\n')!.includes('ubuntu2204-20240530.tar.gz'));
		assert.strictEqual(tools.toolchainUrl('linux', 'arm64', ''), undefined);
		assert.ok(tools.toolchainInstallCommand('https://x/t.dmg', '/d').includes('hdiutil attach'));
		assert.ok(tools.toolchainInstallCommand('https://x/t.tar.gz', '/d').includes("tar -xz -C '/d' --strip-components=1"));
	});

	test('Verilator is built as in the X-HEEP setup guide, at the version X-HEEP uses', () => {
		fs.mkdirSync(path.join(tmp, 'xh', 'util', 'docker'), { recursive: true });
		fs.writeFileSync(path.join(tmp, 'xh', 'util', 'docker', 'dockerfile'), 'ARG riscv=/tools/riscv\nARG verilator_version=v5.042\n');
		assert.strictEqual(tools.xheepVerilatorVersion(path.join(tmp, 'xh')), '5.042');
		assert.strictEqual(tools.xheepVerilatorVersion(path.join(tmp, 'none')), '5.040');
		const cmd = tools.verilatorInstallCommand('5.042');
		assert.ok(cmd.includes('--branch v5.042 https://github.com/verilator/verilator.git'));
		assert.ok(cmd.includes(`./configure --prefix='${path.join(os.homedir(), 'tools', 'verilator', '5.042')}'`));
		assert.ok(cmd.includes('autoconf') && cmd.includes('make install'));
	});

	test('dev container runs the X-HEEP image with this extension', () => {
		const dc = JSON.parse(tools.devcontainerJson('me.ext'));
		assert.strictEqual(dc.image, 'ghcr.io/x-heep/x-heep/x-heep-toolchain:latest');
		assert.deepStrictEqual(dc.customizations.vscode.extensions, ['me.ext']);
	});
});

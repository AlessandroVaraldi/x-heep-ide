import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { Options, buildCommand, simCommand, simModelBuildCommand, mcuGenCommand, explicitImports, simSummary, incrementalBuildCommand, verilatorRunCommand, debugModelBuildCommand, debugSimCommand, cloneCommand,
	builtBitstream, bitstreamBuildCommand, vivadoTcl, openocdFpgaCommand, fileSha1,
	gdbRunCommand, exitCode, regValue, pickSerialPort, serialReadCommand,
	memoryRegions, stackSize, explainBuild, stackProblems, uartException, exceptionCause, printable,
	condaEnvName, requiredVersions, verilatorVersion, veribleVersion, veribleInstallCommands, usbDevices, udevRule, missingModulesCommand,
	boardAdapters, pickAdapter } from '../xheep';

const base: Options = { project: 'hello_world', mode: 'sim', compiler: 'gcc', board: 'pynq-z2', simulator: 'verilator' };

suite('X-HEEP make commands', () => {
	test('simulation builds for sim target with on-chip linker, then runs the hex', () => {
		assert.strictEqual(buildCommand(base), 'make app PROJECT=hello_world TARGET=sim LINKER=on_chip COMPILER=gcc COMPILER_FLAGS=-fstack-usage');
		assert.strictEqual(simCommand({ ...base, simulator: 'questasim' }), 'make questasim-run');
	});

	test('fast paths skip the clean rebuild and fusesoc', () => {
		assert.strictEqual(incrementalBuildCommand(8), 'make -s -C sw/build -j8');
		assert.strictEqual(verilatorRunCommand('/x/build/core/sim-verilator'),
			"cd '/x/build/core/sim-verilator' && ./Vtestharness +firmware=../../../sw/build/main.hex");
	});

	test('simulation debug uses its own JTAG-enabled model', () => {
		// Through make: the boot ROM generator needs COMPILER_PREFIX, which the Makefile exports.
		assert.ok(debugModelBuildCommand().includes("make verilator-build FUSESOC_FLAGS='--build-root build/debug' FUSESOC_PARAM='--JTAG_DPI=1'"));
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xheep-'));
		fs.mkdirSync(path.join(dir, 'build', 'debug', 'sim-verilator'), { recursive: true });
		const cmd = debugModelBuildCommand().replace(/make verilator-build [^&]*/, 'true ');
		assert.strictEqual(spawnSync('/bin/bash', ['-c', cmd], { cwd: dir }).status, 1);
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
			'make app PROJECT=hello_world TARGET=sim LINKER=on_chip COMPILER=gcc SOURCE=../../sw COMPILER_FLAGS=-fstack-usage');
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
			'make app PROJECT=hello_world TARGET=pynq-z2 LINKER=on_chip COMPILER=clang COMPILER_FLAGS=-fstack-usage');
	});

	test('flash mode builds with the flash_load linker', () => {
		assert.strictEqual(buildCommand({ ...base, mode: 'fpga-flash', board: 'nexys-a7-100t' }),
			'make app PROJECT=hello_world TARGET=nexys-a7-100t LINKER=flash_load COMPILER=gcc COMPILER_FLAGS=-fstack-usage');
	});
});

suite('FPGA bitstream', () => {
	const fakeXheep = () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xheep-'));
		fs.mkdirSync(path.join(dir, 'build', 'openhwgroup.org_systems_core-v-mini-mcu_1.0.6', 'pynq-z2-vivado'), { recursive: true });
		return dir;
	};

	test('finds the bitstream fusesoc built for the board', () => {
		const dir = fakeXheep();
		assert.strictEqual(builtBitstream(dir, 'pynq-z2'), undefined);
		const bit = path.join(dir, 'build', 'openhwgroup.org_systems_core-v-mini-mcu_1.0.6', 'pynq-z2-vivado', 'core.bit');
		fs.writeFileSync(bit, '');
		assert.strictEqual(builtBitstream(dir, 'pynq-z2'), bit);
		assert.strictEqual(builtBitstream(dir, 'nexys-a7-100t'), undefined);
	});

	test('bitstream build fails when no bitstream comes out even if make exits 0', () => {
		// `make vivado-fpga` exits 0 also when Vivado fails; a stale bitstream must not count either.
		const dir = fakeXheep();
		fs.writeFileSync(path.join(dir, 'build', 'openhwgroup.org_systems_core-v-mini-mcu_1.0.6', 'pynq-z2-vivado', 'old.bit'), '');
		const cmd = bitstreamBuildCommand('pynq-z2', false).replace('make vivado-fpga FPGA_BOARD=pynq-z2', 'true');
		assert.strictEqual(spawnSync('/bin/bash', ['-c', cmd], { cwd: dir }).status, 1);
	});

	test('the on-board USB adapter gets a BSCAN bitstream', () => {
		assert.ok(bitstreamBuildCommand('pynq-z2', true).includes('make vivado-fpga FPGA_BOARD=pynq-z2 FUSESOC_FLAGS=--flag=use_bscane_xilinx'));
		assert.ok(!bitstreamBuildCommand('pynq-z2', false).includes('FUSESOC_FLAGS'));
	});

	test('loading and clearing the FPGA', () => {
		assert.strictEqual(openocdFpgaCommand('openocd', 'SETUP', '/b/x.bit'), "openocd -c 'SETUP; pld device virtex2 fpga.tap; init; pld load 0 {/b/x.bit}; shutdown'");
		assert.ok(openocdFpgaCommand('openocd', 'SETUP').includes('irscan fpga.tap 0x0b')); // JPROGRAM
		assert.ok(vivadoTcl('xc7z020', '/b/x.bit').includes('set_property PROGRAM.FILE {/b/x.bit} $dev\nprogram_hw_devices $dev'));
		assert.ok(vivadoTcl('xc7z020').includes('boot_hw_device $dev'));
		assert.ok(vivadoTcl('xc7z020').includes('get_hw_devices xc7z020*'));
	});

	test('a bitstream is known by its content, wherever it is copied', () => {
		const dir = fakeXheep();
		fs.writeFileSync(path.join(dir, 'a.bit'), 'bits');
		fs.copyFileSync(path.join(dir, 'a.bit'), path.join(dir, 'copy.bit'));
		assert.strictEqual(fileSha1(path.join(dir, 'copy.bit')), fileSha1(path.join(dir, 'a.bit')));
	});
});

suite('FPGA run over JTAG', () => {
	test('runs to the first instruction of _exit, where a0 still holds the exit code', () => {
		const cmd = gdbRunCommand('/t/gdb', '/x/main.elf');
		assert.ok(cmd.startsWith("'/t/gdb' -q -nx -batch '/x/main.elf' -ex 'set remotetimeout 2000' -ex 'target extended-remote :3333' -ex load"));
		assert.ok(cmd.includes("-ex 'break *_exit' -ex continue -ex 'printf \"XHEEP_EXIT %d\\n\", $a0'"));
		assert.strictEqual(exitCode('Breakpoint 1, 0x00000dda in _exit ()\nXHEEP_EXIT 0\n'), 0);
		assert.strictEqual(exitCode('XHEEP_EXIT -2\n'), -2);
		assert.strictEqual(exitCode('Remote connection closed'), undefined);
	});

	test('picks the X-HEEP UART among the serial ports', () => {
		const byId = '/dev/serial/by-id/';
		const epfl = [0, 1, 2, 3].map(i => `${byId}usb-FTDI_Quad_RS232-HS-if0${i}-port0`);
		assert.strictEqual(pickSerialPort([`${byId}usb-Xilinx_TUL_1234-tul-if01-port0`, ...epfl, '/dev/ttyUSB2']), epfl[2]);
		assert.strictEqual(pickSerialPort(['/dev/ttyUSB0']), '/dev/ttyUSB0');
		assert.strictEqual(pickSerialPort(['/dev/ttyUSB0', '/dev/ttyUSB1']), undefined);
		assert.strictEqual(pickSerialPort([]), undefined);
	});

	test('tells a halted program from one hung on the bus', () => {
		// OpenOCD's replies on a PYNQ-Z2: a busy loop halts; a load nobody answers leaves the hart unhaltable.
		assert.strictEqual(regValue('pc (/32): 0x00000a92\n'), 0xa92);
		assert.strictEqual(regValue(''), undefined);
		assert.strictEqual(regValue('mepc (/32): 0x00000214\n', 'mepc'), 0x214);
	});

	test('reads the UART raw', () => {
		assert.strictEqual(serialReadCommand('/dev/ttyUSB2', 9600), "stty -F '/dev/ttyUSB2' 9600 raw -echo -crtscts cs8 -parenb -cstopb && exec cat '/dev/ttyUSB2'");
	});
});

suite('Explaining failures to newcomers', () => {
	// Lines from real builds of apps written for a PC, on the ci.hjson platform.
	const app = '/p/sw/applications';
	const isApp = (f: string) => f.startsWith(app);
	const ld = 'MEMORY\n{\n    ram0 (rwxa) : ORIGIN = 0x000000, LENGTH = 0x018000\n    ram1 (rwxa) : ORIGIN = 0x018000, LENGTH = 0x018000\n}\n'
		+ '  __stack_size = DEFINED(__stack_size) ? __stack_size : 0x800;\n';

	test('reads the memory regions and the stack size of the platform', () => {
		assert.deepStrictEqual(memoryRegions(ld), { ram0: 0x18000, ram1: 0x18000 });
		assert.strictEqual(stackSize(ld), 0x800);
	});

	test('a memory overflow says how much is missing and what to do', () => {
		const log = "/t/riscv32-corev-elf/bin/ld: region `ram1' overflowed by 707136 bytes\ncollect2: error: ld returned 1 exit status\n";
		const [p] = explainBuild(log, memoryRegions(ld), isApp);
		assert.strictEqual(p.file, undefined);
		assert.ok(p.message.startsWith('The app does not fit in memory: it needs 707136 bytes more than ram1, which holds 96 KB.'));
		assert.ok(p.message.includes('Select Platform Configuration'));
	});

	test('functions that need an operating system say what to use instead', () => {
		const log = `${app}/sleep_app/main.c:4:(.text.startup.main+0x1e): undefined reference to \`sleep'\n`
			+ "/build/libstdc++-v3/src/c++11/ext11-inst.cc:259:(.text._ZN9__gnu_cxx18stdio_sync_filebuf+0xa): undefined reference to `getwc'\n"
			+ `${app}/pthread_app/main.c:6:5: error: implicit declaration of function 'pthread_create' [-Wimplicit-function-declaration]\n`;
		const ps = explainBuild(log, {}, isApp);
		assert.strictEqual(ps.length, 2); // nothing on the C++ library's own references
		assert.deepStrictEqual([ps[0].file, ps[0].line, ps[0].severity], [`${app}/sleep_app/main.c`, 4, 'error']);
		assert.ok(ps[0].message.startsWith('sleep() is not available on X-HEEP. X-HEEP has no operating system to sleep'));
		assert.deepStrictEqual([ps[1].line, ps[1].column, ps[1].severity], [6, 5, 'info']);
		assert.ok(ps[1].message.includes('FreeRTOS'));
	});

	test('functions too big for the stack are flagged where they are defined', () => {
		const su = `${app}/big_stack/main.c:4:5:process\t16400\tstatic\n${app}/big_stack/main.c:10:5:main\t16\tstatic\n`
			+ `${app}/vla/main.c:3:5:filter\t32\tdynamic\n/x/sw/device/lib/runtime/syscalls.c:9:5:_write\t4096\tstatic\n`;
		const ps = stackProblems(su, 2048, isApp);
		assert.deepStrictEqual(ps.map(p => [p.file, p.line, p.column]), [[`${app}/big_stack/main.c`, 4, 5], [`${app}/vla/main.c`, 3, 5]]);
		assert.ok(ps[0].message.startsWith("process() needs 16400 bytes of stack, but X-HEEP's stack is 2048 bytes"));
		assert.ok(ps[1].message.includes('variable-length array'));
	});

	test('exceptions reported on the UART, and their causes', () => {
		assert.strictEqual(uartException('before\nIllegal Instruction fault, mtval shows instruction content\nMTVAL value is '), 'illegal instruction');
		assert.strictEqual(uartException('Load/Store fault, mtval shows the fault address\n'), 'load/store access fault');
		assert.strictEqual(uartException('hello world!\n'), undefined);
		assert.strictEqual(uartException('Illegal Instruction fault, mtval show'), undefined); // not until the line is complete
		assert.strictEqual(exceptionCause(2), 'illegal instruction');
		assert.strictEqual(exceptionCause(7), 'store access fault');
		assert.strictEqual(printable('MTVAL value is \u0000\u0000\u0013\n'), 'MTVAL value is \n');
	});

	test('the simulator stopping on an address outside the memory map', () => {
		assert.deepStrictEqual(simSummary('                   0 Out of bound memory access 0x5850006c\n%Error: system_bus.sv:254: Verilog $stop\n'),
			{ ok: false, text: "memory access outside X-HEEP's memory map at 0x5850006c" });
	});
});

suite('Environment check', () => {
	test('finds the conda environment the setup activates', () => {
		assert.strictEqual(condaEnvName('eval "$(conda shell.bash hook)" && conda activate x-heep'), 'x-heep');
		assert.strictEqual(condaEnvName('source ~/miniconda3/bin/activate; conda activate core-v-mini-mcu && export X=1'), 'core-v-mini-mcu');
		assert.strictEqual(condaEnvName('source .venv/bin/activate'), undefined);
	});

	test('reads the tool versions from the setup guide and from the tools', () => {
		assert.deepStrictEqual(requiredVersions('export VERILATOR_VERSION=5.040\n...\nexport VERIBLE_VERSION=v0.0-4023-gc1271a00\n'),
			{ verilator: '5.040', verible: 'v0.0-4023-gc1271a00' });
		assert.strictEqual(verilatorVersion('Verilator 5.040 2025-08-30 rev v5.040\n'), '5.040');
		assert.strictEqual(veribleVersion('Version\tv0.0-4023-gc1271a00\nCommit-Timestamp\t2025-08-29T09:25:59Z\n'), 'v0.0-4023-gc1271a00');
		assert.strictEqual(veribleVersion('v0.0-1824-ga3b5bedf\nCommit\t2022-01-14 23:24:43 -0800\n'), 'v0.0-1824-ga3b5bedf');
		assert.ok(veribleInstallCommands('v0.0-4023-gc1271a00')[0].endsWith('/v0.0-4023-gc1271a00/verible-v0.0-4023-gc1271a00-linux-static-x86_64.tar.gz'));
	});

	test('checks the Python packages in the environment python', () => {
		assert.ok(missingModulesCommand().includes('hjson mako fusesoc edalize pkg_resources'));
		assert.ok(missingModulesCommand().includes('.venv/bin/python'));
	});

	test('lists USB devices from sysfs with their device node', () => {
		const sysfs = fs.mkdtempSync(path.join(os.tmpdir(), 'usb-'));
		const dev = (name: string, files: Record<string, string>) => {
			fs.mkdirSync(path.join(sysfs, name));
			Object.entries(files).forEach(([f, v]) => fs.writeFileSync(path.join(sysfs, name, f), `${v}\n`));
		};
		dev('1-3', { idVendor: '0403', idProduct: '6011', busnum: '1', devnum: '15', product: 'Quad RS232-HS' });
		dev('1-3:1.0', { bInterfaceNumber: '00' }); // interfaces have no ids
		assert.deepStrictEqual(usbDevices(sysfs), [{ vid: '0403', pid: '6011', product: 'Quad RS232-HS', node: '/dev/bus/usb/001/015' }]);
		assert.strictEqual(udevRule('0403', '6011'), 'ATTRS{idVendor}=="0403", ATTRS{idProduct}=="6011", MODE="666", GROUP="plugdev"');
	});
});

suite('JTAG adapter', () => {
	const labels = (as: { label: string }[]) => as.map(a => a.label);
	const plugged = (...ids: string[]) => (usb: string) => ids.includes(usb);

	test('only the adapters that fit the board and the bitstream', () => {
		assert.deepStrictEqual(labels(boardAdapters('pynq-z2')), ['EPFL Programmer', 'On-board USB (BSCAN)', 'Digilent JTAG-HS2']);
		assert.deepStrictEqual(labels(boardAdapters('aup-zu3')), ['EPFL Programmer', 'Digilent JTAG-HS2']);
		assert.deepStrictEqual(labels(boardAdapters('pynq-z2', true)), ['On-board USB (BSCAN)']);
		assert.deepStrictEqual(labels(boardAdapters('pynq-z2', false)), ['EPFL Programmer', 'Digilent JTAG-HS2']);
	});

	test('the one plugged in, the on-board USB only when no external adapter is', () => {
		const pynq = boardAdapters('pynq-z2');
		assert.strictEqual(pickAdapter(pynq, plugged('0403:6011', '0403:6010')).adapter?.label, 'EPFL Programmer');
		assert.strictEqual(pickAdapter(pynq, plugged('0403:6010')).adapter?.label, 'On-board USB (BSCAN)');
		assert.deepStrictEqual(labels(pickAdapter(pynq, plugged('0403:6011', '0403:6014', '0403:6010')).choices), ['EPFL Programmer', 'Digilent JTAG-HS2']);
		assert.deepStrictEqual(labels(pickAdapter(pynq, plugged()).choices), ['EPFL Programmer', 'On-board USB (BSCAN)', 'Digilent JTAG-HS2']);
		// A BSCAN bitstream leaves a single candidate: used even if not seen, OpenOCD then tells.
		assert.strictEqual(pickAdapter(boardAdapters('pynq-z2', true), plugged()).adapter?.label, 'On-board USB (BSCAN)');
	});
});

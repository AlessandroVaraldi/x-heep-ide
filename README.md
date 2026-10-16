# X-HEEP IDE (Alpha)

VS Code extension for developing software on [X-HEEP](https://github.com/esl-epfl/x-heep).
Clone X-HEEP, open the folder in VS Code, and the extension activates.

## Features

- **Applications view** (X-HEEP icon in the activity bar): lists `sw/applications`, with inline Build / Run / Debug.
- **Run modes** (status bar): where *Run* and *Debug* take the app:
  - **Simulation**: Run simulates the app on the RTL model (built first if missing); Debug runs GDB on a
    JTAG-enabled model.
  - **FPGA · JTAG**: loads the bitstream if needed and the app into X-HEEP's RAM over JTAG (OpenOCD). Run runs it
    like a simulation; Debug opens a GDB session. Each run starts from a reset X-HEEP, also when the CPU hung.
    The JTAG adapter is the one plugged in among those fitting the board and the bitstream (EPFL programmer,
    PYNQ-Z2 on-board USB with a BSCAN bitstream, Digilent JTAG-HS2); `xheep.openocdConfig` forces one.
  - **FPGA · Flash**: the app goes into the SPI flash and X-HEEP boots it by itself, as the chip would (no
    debugger): builds with `LINKER=flash_load`, clears the FPGA, runs `make flash-prog` and reloads the bitstream;
    with the boot select switch on flash, the app starts right away.
- **UART output** in the *X-HEEP UART* panel, for simulations and the board alike, each run under a header and
  closed by its exit code: runs and debug sessions end by themselves when the program reaches `_exit`. The board's
  UART is found by itself with the EPFL programmer (or set `xheep.serialPort`); **Open Serial Monitor** gives an
  interactive terminal instead.
- **Problems panel**: compiler errors and warnings from builds, plus what X-HEEP newcomers trip on, explained:
  an app that does not fit in memory, functions that need an operating system (`sleep`, `pthread_*`), functions
  whose stack frame exceeds X-HEEP's stack (from GCC's `-fstack-usage`).
- **Run failures explained**: a program that hits an exception stops with it (and, on the board, where it
  happened); an address outside the memory map in simulation is reported as such; on the board, Cancel tells
  where a program that does not end is, or that it hangs on a memory access nobody answers.
- **IntelliSense**: every build writes `sw/build/compile_commands.json`, used by the C/C++ extension.
- **Environment check** (at startup, on demand, and when switching to an FPGA mode), saying what to do for each
  problem, with one-click fixes:
  - the Python environment: no conda, no such environment, or missing X-HEEP packages (`make conda`);
  - the RISC-V toolchain, Verilator and verible against the versions in X-HEEP's setup guide (an old verible makes
    platform generation reformat X-HEEP's own files), with the install commands;
  - in the FPGA modes, the hardware: JTAG adapter, EPFL programmer and board connected and usable (udev rule),
    the UART (dialout group), iceprog's libftdi; OpenOCD, picocom and Vivado otherwise reported as optional.

The platform is generated from `configs/general.py` by default (see **Select Platform Configuration**); it is
regenerated with `make mcu-gen` whenever the configuration changes.

## Platform configurations

Click the configuration in the status bar to pick one of the existing configurations, or to create one:
- **New configuration (Python)** starts from X-HEEP's `configs/general.py`, to edit as code;
- **New configuration with the editor** (experimental) opens a form over the active configuration's values: CPU
  and FPU, bus, RAM banks, code size, interleaved banks, stack and heap, peripherals.

The editor shows what X-HEEP's own generator reads from a configuration (`media/platform.py` runs
`util/xheep_gen`), whether it is Python or HJSON, and says what saving costs: stack, heap and code size only change
the linker script, the rest needs a new simulation model and, on the FPGA, a new bitstream.

It never edits a configuration. **Save as…** writes a short Python file that loads the starting configuration
and changes only what the form changed, e.g. `configs/my_soc.py` on top of `configs/general.py`; the generator
checks it first. Configurations written by the editor have an edit button in the menu, which reopens them in the
editor; deleting their `# xheep-ide:` line hands them over to you. Address map, peripheral offsets, interrupts,
pads and custom memory layouts stay in Python or HJSON.

With a hardware FPU, apps are built with `ARCH=rv32imfc_zicsr`.

## FPGA boards and bitstreams

Officially supported boards: **PYNQ-Z2** and **AUP-ZU3**. The other X-HEEP boards can be selected in
`xheep.fpgaBoard`, untested.

Loading a bitstream needs no Vivado on the PYNQ-Z2: OpenOCD, already needed for JTAG debugging, programs the FPGA
through the board's USB port. Other boards load through Vivado. The bitstream is `xheep.bitstream` (e.g. a `.bit`
file handed out with the course), or else the one built in `x-heep/build/` for the board.

Building a bitstream needs Vivado: **Build Bitstream** only shows up when Vivado is installed. It builds for the
active platform configuration (with the Xilinx BSCAN JTAG when the on-board USB adapter is selected).

In the FPGA modes, the extension checks that apps are generated for the hardware the bitstream was built for, and
offers to switch back to that configuration. It keeps what it knows of each bitstream in its own storage, under
the bitstream's sha1: nothing is written next to the `.bit` or into X-HEEP, and copies are recognised. For a
bitstream it built, it knows the platform; for one from elsewhere, it asks once which configuration it was built
for (or "I don't know", which skips the check).

## Software-only projects

Keep your apps in your own repo, with X-HEEP next to them:

```
my-project/
  sw/applications/<app>/main.c   your code, your commits
  sw/device -> ../x-heep/sw/device   created by the extension, gitignored
  x-heep/                        git submodule, or a symlink to an existing clone
```

Open an empty folder and run **X-HEEP: New Software Project**. Your apps are built with
`make app SOURCE=<path to my-project/sw>`. X-HEEP sources and docs stay browsable under `x-heep/`.

## Settings

All under `xheep.*`: `envSetup`, `riscvToolchain`, `compiler`, `mcuConfig`, `simulator`, `fpgaBoard`, `bitstream`,
`fpgaProgrammer`, `openocdPath`, `openocdConfig`, `serialPort`, `serialBaud`.

## Development

```sh
npm install
npm run compile   # or: npm run watch
npm test
```

Press F5 to open an Extension Development Host, then open the X-HEEP folder in it.

`make e2e` runs the extension's software-project steps against a fresh X-HEEP clone (clone, mcu-gen,
build, Verilator model, simulation); it needs the X-HEEP tools. CI runs it in the x-heep-toolchain image.

## Releasing

`make patch` (or `minor`, `major`) bumps the version, tags `v<version>` and pushes: CI then runs the tests
and the end-to-end check, publishes to the Marketplace and creates the GitHub release with the `.vsix`.
Add the new version to `CHANGELOG.md` first.

## X-HEEP compatibility

`XHEEP_COMMIT` holds the last X-HEEP commit the extension is known to work with; new software projects
clone X-HEEP at that commit (read live from this repo, falling back to the copy in the package).
The `X-HEEP canary` workflow runs the end-to-end check on each new X-HEEP `main` commit: if it passes it
updates the pin, otherwise it keeps the old one and opens an issue labelled `xheep-canary`.

It checks X-HEEP every night at midnight (Italian time) and makes a minor release with each new pin. To test right after each X-HEEP push, add this job to X-HEEP's CI, with a
`X_HEEP_IDE_DISPATCH` secret holding a token that can write to this repository's contents:

```yaml
on:
  push:
    branches: [main]
jobs:
  notify-ide:
    runs-on: ubuntu-latest
    steps:
      - run: gh api repos/LuigiGiuffrida98/x-heep-ide/dispatches -f event_type=xheep-push
        env:
          GH_TOKEN: ${{ secrets.X_HEEP_IDE_DISPATCH }}
```

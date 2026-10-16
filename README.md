# X-HEEP IDE (Alpha)

VS Code extension for developing software on [X-HEEP](https://github.com/esl-epfl/x-heep).
Clone X-HEEP, open the folder in VS Code, and the extension activates.

## Features

- **Applications view** (X-HEEP icon in the activity bar): lists `sw/applications`, with inline Build / Run / Debug.
- **Run modes** (status bar): pick how *Run* behaves:
  - **Simulation**: `make <simulator>-run-app` (builds the RTL model first if missing).
  - **FPGA · JTAG Debug**: builds for the board, starts OpenOCD and a GDB session (breaks at `main`).
  - **FPGA · Flash**: builds with `LINKER=flash_load`, runs `make flash-prog`, opens the UART.
- **Problems panel**: compiler errors and warnings from builds.
- **IntelliSense**: every build writes `sw/build/compile_commands.json`, used by the C/C++ extension.
- **Environment check**: conda env, RISC-V toolchain, mcu-gen output, fusesoc, simulator, OpenOCD, picocom, with one-click fixes.

The extension assumes the bitstream is already on the FPGA and the platform is generated from `configs/general.py`.
If the platform is missing, it offers to run `make mcu-gen`.
 
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

All under `xheep.*`: `envSetup`, `riscvToolchain`, `compiler`, `mcuConfig`, `simulator`, `fpgaBoard`,
`openocdPath`, `openocdConfig`, `serialPort`, `serialBaud`.

## Development

```sh
npm install
npm run compile   # or: npm run watch
npm test
```

Press F5 to open an Extension Development Host, then open the X-HEEP folder in it.

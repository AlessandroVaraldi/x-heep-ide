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

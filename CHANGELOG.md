# Change Log

## 0.0.1 (preview)

- Applications view: your apps and the X-HEEP examples, new app and new file.
- Run modes: Simulation (Verilator/Questasim), FPGA JTAG debug (EPFL Programmer, on-board BSCAN, Digilent HS2), FPGA flash.
- Automatic platform generation (mcu-gen) and simulation model build when the configuration changes.
- Platform configurations kept in your project (`configs/*.py`), with a template from X-HEEP.
- Fast incremental builds and direct Verilator runs; UART output in its own panel.
- VS Code debugger (breakpoints, stepping) over OpenOCD, in simulation and on FPGA.
- Software-only projects with X-HEEP as a git submodule or a linked clone.
- Environment check with one-click fixes.

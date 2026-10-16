// The platform editor panel: a webview form over the active configuration (see platform.ts for the model).
// The extension feeds it what X-HEEP's generator reads and does the writing; the page only edits a form.

import * as vscode from 'vscode';
import { Catalog, Platform, PlatformForm } from './platform';

/** What the page shows. */
export interface EditorState {
	name: string;
	/** The active configuration, as shown to the user. */
	file: string;
	/** For an overlay: the configuration it builds on. */
	base?: string;
	/** The form as the active configuration reads now. */
	form: PlatformForm;
	/** Read as is, for memory the form cannot represent. */
	platform: Platform;
	memoryEditable: boolean;
	catalog: Catalog;
	/** Whether the loaded bitstream fits the active configuration; undefined without a bitstream or its metadata. */
	bitstreamMatches?: boolean;
	/** The active app's largest stack frame, to size the stack. */
	largestFrame?: { fn: string; app: string; bytes: number };
	/** RAM the board's FPGA can hold, in KB. */
	boardRamKb?: number;
	board: string;
}

export interface EditorHost {
	/** Reads the active configuration; undefined with an error message when it cannot. */
	load(): Promise<EditorState | { error: string }>;
	/** Writes the form: resolves with xheep_gen's complaint when it rejects it, or cancelled (e.g. no name given). */
	apply(form: PlatformForm): Promise<{ error?: string; cancelled?: boolean }>;
	switchConfig(): Promise<void>;
	openFile(): void;
}

let panel: vscode.WebviewPanel | undefined;

export function openPlatformEditor(host: EditorHost) {
	if (panel) {
		panel.reveal();
		return;
	}
	panel = vscode.window.createWebviewPanel('xheep.platform', 'X-HEEP Platform', vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true });
	const nonce = Math.random().toString(36).slice(2);
	panel.webview.html = html(nonce, panel.webview.cspSource);
	const post = (m: unknown) => panel?.webview.postMessage(m);
	const load = async () => {
		post({ type: 'busy', text: 'Reading the configuration…' });
		const state = await host.load();
		if (panel && 'name' in state) {
			panel.title = `Platform: ${state.name}`;
		}
		post('error' in state ? { type: 'error', text: state.error } : { type: 'load', state });
	};
	panel.webview.onDidReceiveMessage(async m => {
		switch (m.type) {
			case 'ready': return load();
			case 'apply': {
				post({ type: 'busy', text: 'Checking with X-HEEP\'s generator…' });
				const { error, cancelled } = await host.apply(m.form);
				return cancelled ? post({ type: 'idle' }) : error ? post({ type: 'error', text: error, keep: true }) : load();
			}
			case 'switch': await host.switchConfig(); return load();
			case 'open': return host.openFile();
		}
	});
	panel.onDidDispose(() => { panel = undefined; });
}

/** Reloads the editor after the active configuration changed elsewhere. */
export function refreshPlatformEditor() {
	panel?.webview.postMessage({ type: 'reload' });
}

function html(nonce: string, csp: string): string {
	return /* html */ `<!doctype html>
<html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${csp} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
:root {
	--fg: var(--vscode-foreground); --muted: var(--vscode-descriptionForeground); --line: var(--vscode-panel-border, var(--vscode-widget-border, #8884));
	--bg: var(--vscode-editor-background); --accent: var(--vscode-button-background); --accent-fg: var(--vscode-button-foreground);
	--warn: var(--vscode-editorWarning-foreground); --warn-bg: var(--vscode-inputValidation-warningBackground, #cca70022);
	--err: var(--vscode-errorForeground); --ok: var(--vscode-testing-iconPassed, #388a34);
	--seg-code: var(--vscode-charts-blue); --seg-data: var(--vscode-charts-green); --seg-heap: var(--vscode-charts-purple);
	--seg-stack: var(--vscode-charts-orange); --seg-il: var(--vscode-charts-red); --seg-free: var(--vscode-input-background);
	--mono: var(--vscode-editor-font-family);
}
body { color: var(--fg); background: var(--bg); font: var(--vscode-font-size) / 1.5 var(--vscode-font-family); padding: 0 16px 0; margin: 0; }
.wrap { max-width: 760px; margin: 0 auto; }
header { padding: 18px 0 6px; display: grid; gap: 4px; }
h1 { font-size: 1.4em; font-weight: 600; margin: 0; }
.sub { color: var(--muted); display: flex; flex-wrap: wrap; gap: 4px 14px; align-items: center; }
code, .num { font-family: var(--mono); }
.num { font-variant-numeric: tabular-nums; }
a, .link { color: var(--vscode-textLink-foreground); cursor: pointer; background: none; border: 0; padding: 0; font: inherit; }
.chip { display: inline-flex; align-items: center; gap: 6px; padding: 0 8px; border-radius: 10px; border: 1px solid var(--line); }
.chip::before { content: ""; width: 7px; height: 7px; border-radius: 50%; background: var(--ok); }
.chip.warn::before { background: var(--warn); }
section { padding: 16px 0; border-top: 1px solid var(--line); display: grid; gap: 12px; }
h2 { font-size: .85em; letter-spacing: .08em; text-transform: uppercase; color: var(--muted); margin: 0; font-weight: 600; }
.row { display: grid; grid-template-columns: 150px 1fr; gap: 8px 16px; align-items: start; }
.row > .lab { padding-top: 4px; }
.hint { color: var(--muted); margin-top: 4px; }
@media (max-width: 560px) { .row { grid-template-columns: 1fr; } .row > .lab { padding-top: 0; font-weight: 600; } }
select, input[type=number] { font: inherit; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, var(--line)); border-radius: 2px; padding: 3px 6px; }
select { max-width: 100%; }
input[type=number] { width: 80px; font-family: var(--mono); }
:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }
.seg { display: inline-flex; flex-wrap: wrap; border: 1px solid var(--line); border-radius: 2px; overflow: hidden; }
.seg button { font: inherit; color: var(--fg); background: transparent; border: 0; padding: 3px 12px; cursor: pointer; }
.seg button + button { border-left: 1px solid var(--line); }
.seg button[aria-pressed="true"] { background: var(--accent); color: var(--accent-fg); }
.seg button:disabled { opacity: .5; cursor: default; }
.toggle { display: inline-flex; align-items: center; gap: 8px; }
.stepper { display: inline-flex; align-items: center; gap: 6px; }
.stepper button { font: inherit; width: 24px; height: 24px; border: 1px solid var(--line); background: transparent; color: var(--fg); border-radius: 2px; cursor: pointer; }
.bar { display: flex; height: 24px; border-radius: 3px; overflow: hidden; background: var(--seg-free); }
.bar div { min-width: 0; }
.bar .code { background: var(--seg-code); } .bar .data { background: var(--seg-data); } .bar .heap { background: var(--seg-heap); }
.bar .stack { background: var(--seg-stack); } .bar .gap { flex: 0 0 2px; background: var(--bg); }
.bar .il { background: repeating-linear-gradient(90deg, var(--seg-il) 0 6px, transparent 6px 8px); }
.ticks { display: flex; justify-content: space-between; font-family: var(--mono); font-size: .85em; color: var(--muted); margin-top: 3px; }
.legend { display: flex; flex-wrap: wrap; gap: 4px 16px; }
.legend span { display: inline-flex; align-items: center; gap: 6px; }
.legend i { width: 9px; height: 9px; border-radius: 2px; display: inline-block; }
.legend .v { font-family: var(--mono); color: var(--muted); }
.periph { display: grid; grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); gap: 6px; }
.periph label { display: flex; gap: 8px; align-items: flex-start; padding: 6px 8px; border: 1px solid var(--line); border-radius: 3px; cursor: pointer; }
.periph small { display: block; color: var(--muted); }
.note { padding: 8px 10px; border-radius: 3px; background: var(--warn-bg); }
.note b { color: var(--warn); }
.note.err b { color: var(--err); }
footer { position: sticky; bottom: 0; background: var(--bg); border-top: 1px solid var(--line); padding: 10px 0; display: flex; flex-wrap: wrap; gap: 8px 14px; align-items: center; }
footer .cost { color: var(--muted); flex: 1 1 260px; min-width: 0; }
.btn { font: inherit; border-radius: 2px; padding: 4px 14px; cursor: pointer; border: 1px solid var(--vscode-button-border, transparent);
	background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
.btn.primary { background: var(--accent); color: var(--accent-fg); }
.btn:disabled { opacity: .5; cursor: default; }
#status { padding: 24px 0; color: var(--muted); }
</style></head>
<body><div class="wrap">
<div id="status">Reading the configuration…</div>
<div id="editor" hidden>
	<header>
		<h1 id="name"></h1>
		<div class="sub"><span id="where"></span><button class="link" id="switch">Switch configuration</button><button class="link" id="open">Open as code</button><span id="chip" class="chip" hidden></span></div>
	</header>
	<section>
		<h2>Core</h2>
		<div class="row">
			<label class="lab" for="cpu">CPU</label>
			<div><select id="cpu"></select><div class="hint" id="cpu-hint"></div></div>
			<div class="lab">Floating point</div>
			<div><label class="toggle"><input type="checkbox" id="fpu"> Hardware FPU (F extension)</label><div class="hint" id="fpu-hint"></div></div>
			<div class="lab">Bus</div>
			<div><div class="seg" role="group" aria-label="Bus"><button id="bus-onetoM">One master at a time</button><button id="bus-NtoM">Parallel (N to M)</button></div>
				<div class="hint">Parallel lets the DMA and accelerators use memory while the CPU runs. It takes more FPGA area.</div></div>
		</div>
	</section>
	<section>
		<h2>Memory</h2>
		<div><div class="bar" id="bar" aria-hidden="true"><div class="code"></div><div class="data"></div><div class="heap"></div><div class="stack"></div><div class="gap"></div><div class="il"></div></div><div class="ticks" id="ticks"></div></div>
		<div class="legend" id="legend"></div>
		<div class="row" id="mem-form">
			<div class="lab">RAM banks</div>
			<div><div class="stepper"><button id="banks-dn" aria-label="Fewer banks">−</button><span class="num" id="banks"></span><button id="banks-up" aria-label="More banks">+</button></div><div class="hint" id="banks-hint"></div></div>
			<label class="lab" for="code">Code</label>
			<div><input type="number" id="code" min="8" step="2"> KB<div class="hint">Program instructions and constants. The rest of the RAM holds data, heap and stack.</div></div>
			<div class="lab">Interleaved banks</div>
			<div><div style="display:flex; flex-wrap:wrap; gap:8px 14px; align-items:center;"><div class="seg" role="group" aria-label="Interleaved banks" id="il-num"></div>
				<label class="toggle" for="il-size">of <select id="il-size"><option value="8">8 KB</option><option value="16">16 KB</option><option value="32">32 KB</option></select></label></div>
				<div class="hint">Consecutive words alternate across these banks, so the DMA and accelerators read them in parallel. Put data there with <code>__attribute__((section(".xheep_data_interleaved")))</code>.</div></div>
		</div>
		<div class="hint" id="mem-custom" hidden></div>
		<div class="row">
			<label class="lab" for="stack">Stack</label>
			<div><input type="number" id="stack" min="1" step="1"> KB<div class="hint" id="stack-hint"></div></div>
			<label class="lab" for="heap">Heap</label>
			<div><input type="number" id="heap" min="0" step="1"> KB<div class="hint">Memory for <code>malloc</code>.</div></div>
		</div>
	</section>
	<section>
		<h2>Peripherals</h2>
		<div class="periph" id="periph"></div>
		<div class="hint">Always included: SoC control, boot ROM, SPI flash, DMA, power manager, always-on timer and GPIO, pad control.</div>
	</section>
	<div id="notes" style="display:grid; gap:6px; padding-bottom:12px"></div>
	<footer><span class="cost" id="cost"></span><button class="btn" id="revert">Revert</button><button class="btn primary" id="apply">Apply</button></footer>
</div>
</div>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const $ = id => document.getElementById(id);
const CPU_DOC = { cv32e20: 'small, RV32IMC. The default.', cv32e40p: 'larger and faster, optional FPU, PULP DSP instructions.',
	cv32e40x: 'X-interface for custom coprocessors.', cv32e40px: 'cv32e40p with the X-interface.' };
const FPU_CPUS = ['cv32e40p', 'cv32e40px'];
const HW = ['cpu', 'fpu', 'bus', 'banks', 'ilNum', 'ilSizeKb', 'peripherals'];
let st, f, error;

window.addEventListener('message', ({ data: m }) => {
	if (m.type === 'busy') { $('cost').textContent = m.text; $('apply').disabled = true; if (!st) { $('status').textContent = m.text; } }
	if (m.type === 'error') { if (m.keep && st) { error = m.text; render(); } else { $('status').hidden = false; $('editor').hidden = true; $('status').textContent = m.text; } }
	if (m.type === 'load') { st = m.state; f = structuredClone(st.form); error = undefined; $('status').hidden = true; $('editor').hidden = false; render(); }
	if (m.type === 'reload') { vscode.postMessage({ type: 'ready' }); }
	if (m.type === 'idle' && st) { render(); }
});

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const kb = n => n + ' KB';
const hex = k => '0x' + (k * 1024).toString(16).toUpperCase().padStart(5, '0');

function render() {
	$('name').textContent = st.name;
	$('where').innerHTML = st.base ? 'Based on <code></code>' : '<code></code>';
	$('where').querySelector('code').textContent = st.base || st.file;
	$('cpu').innerHTML = st.catalog.cpus.map(c => '<option value="' + c + '">' + c + ' · ' + (CPU_DOC[c] || '') + '</option>').join('');
	$('cpu').value = f.cpu;
	const fpuOk = FPU_CPUS.includes(f.cpu);
	if (!fpuOk) f.fpu = false;
	$('fpu').checked = f.fpu; $('fpu').disabled = !fpuOk;
	$('fpu-hint').textContent = !fpuOk ? 'Only cv32e40p and cv32e40px have an FPU.' : f.fpu ? 'Apps are built with ARCH=rv32imfc_zicsr to use it.' : 'Floats are computed in software.';
	$('cpu-hint').textContent = 'Changing the CPU resets its other options to their defaults.';
	for (const b of ['onetoM', 'NtoM']) $('bus-' + b).setAttribute('aria-pressed', String(f.bus === b));

	// Memory: the bar shows the form, or the configuration as is when the form cannot represent it.
	const banksKb = st.memoryEditable ? f.banks * 32 : st.platform.banks.reduce((a, b) => a + b, 0);
	const il = st.memoryEditable ? f.ilNum * f.ilSizeKb : st.platform.interleaved.reduce((a, g) => a + g.num * g.sizeKb, 0);
	$('mem-form').hidden = !st.memoryEditable;
	$('mem-custom').hidden = st.memoryEditable;
	$('mem-custom').textContent = 'This configuration has its own memory layout (' + st.platform.banks.map(kb).join(' + ')
		+ (il ? ', interleaved ' + st.platform.interleaved.map(g => g.num + ' × ' + kb(g.sizeKb)).join(' + ') : '') + '): change it in its Python or HJSON file.';
	$('banks').textContent = f.banks + ' × 32 KB = ' + kb(f.banks * 32);
	$('banks-hint').textContent = st.boardRamKb ? '32 KB each. The ' + st.board + ' holds about ' + kb(st.boardRamKb) + ' of RAM, interleaved banks included.' : '32 KB each.';
	$('il-num').innerHTML = [0, 1, 2, 4, 8].map(n => '<button data-n="' + n + '" aria-pressed="' + (f.ilNum === n) + '">' + (n || 'None') + '</button>').join('');
	$('il-num').querySelectorAll('button').forEach(b => b.onclick = () => { f.ilNum = Number(b.dataset.n); render(); });
	$('il-size').value = String(f.ilSizeKb); $('il-size').disabled = !f.ilNum;
	$('code').value = f.codeKb; $('stack').value = f.stackKb; $('heap').value = f.heapKb;
	const data = Math.max(banksKb - f.codeKb - f.stackKb - f.heapKb, 0);
	const parts = { code: f.codeKb, data, heap: f.heapKb, stack: f.stackKb, il };
	const all = banksKb + il;
	for (const [k, v] of Object.entries(parts)) $('bar').querySelector('.' + k).style.flex = '0 0 calc(' + Math.min(v / all, 1) * 100 + '% - ' + (k === 'il' && il ? 2 : 0) + 'px)';
	$('bar').querySelector('.gap').hidden = !il;
	$('ticks').innerHTML = '<span>' + hex(0) + '</span><span>' + hex(f.codeKb) + '</span><span>' + hex(banksKb) + '</span>' + (il ? '<span>' + hex(all) + '</span>' : '');
	$('legend').innerHTML = [['code', 'Code'], ['data', 'Data'], ['heap', 'Heap'], ['stack', 'Stack'], ...(il ? [['il', 'Interleaved']] : [])]
		.map(([k, l]) => '<span><i style="background:var(--seg-' + k + ')"></i>' + l + ' <span class="v">' + kb(parts[k]) + '</span></span>').join('');
	const frame = st.largestFrame;
	$('stack-hint').innerHTML = 'Local variables of all the functions running at once.';
	if (frame && frame.bytes > f.stackKb * 1024) {
		$('stack-hint').innerHTML += ' <b style="color:var(--warn)"></b>';
		$('stack-hint').querySelector('b').textContent = frame.fn + '() in ' + frame.app + ' alone needs ' + Math.ceil(frame.bytes / 1024) + ' KB.';
	}

	const names = st.catalog.userPeripherals;
	$('periph').innerHTML = names.map(p => '<label><input type="checkbox" data-p="' + p.name + '"' + (f.peripherals.includes(p.name) ? ' checked' : '') + '><span>' + p.name + '<small></small></span></label>').join('');
	$('periph').querySelectorAll('input').forEach((el, i) => {
		el.parentElement.querySelector('small').textContent = names[i].doc;
		el.onchange = () => { f.peripherals = el.checked ? [...f.peripherals, el.dataset.p].sort() : f.peripherals.filter(x => x !== el.dataset.p); render(); };
	});

	const notes = [];
	if (st.memoryEditable && f.codeKb + f.stackKb + f.heapKb >= f.banks * 32) notes.push(['err', 'Does not fit:', 'code, stack and heap take more than the RAM. Add banks or shrink them.']);
	if (st.boardRamKb && all > st.boardRamKb) notes.push(['', 'Too big for the ' + st.board + ':', 'more than about ' + kb(st.boardRamKb) + ' of RAM does not fit its FPGA. Simulation still works.']);
	if (il && f.bus !== 'NtoM') notes.push(['', 'Interleaved banks with a one-master bus:', 'the DMA cannot read them while the CPU runs, so they bring little. Pick the parallel bus.']);
	if (!f.peripherals.includes('uart')) notes.push(['', 'No UART:', 'printf output goes nowhere.']);
	if (error) notes.push(['err', 'X-HEEP\\'s generator rejects this configuration:', error]);
	$('notes').innerHTML = notes.map(([c]) => '<div class="note ' + c + '"><b></b> <span></span></div>').join('');
	$('notes').querySelectorAll('.note').forEach((n, i) => { n.querySelector('b').textContent = notes[i][1]; n.querySelector('span').textContent = notes[i][2]; });

	const changed = Object.keys(f).filter(k => !same(f[k], st.form[k]));
	const hw = changed.filter(k => HW.includes(k));
	const chip = $('chip');
	chip.hidden = st.bitstreamMatches === undefined;
	chip.className = st.bitstreamMatches && !hw.length ? 'chip' : 'chip warn';
	chip.textContent = st.bitstreamMatches && !hw.length ? 'Matches the loaded bitstream' : 'Needs a new bitstream for the FPGA';
	$('cost').textContent = !changed.length ? 'No changes.' : changed.length + ' change' + (changed.length > 1 ? 's' : '') + '. '
		+ (hw.length ? 'The next build regenerates the platform and the simulation model (a few minutes); the FPGA needs a new bitstream.'
			: 'The next build regenerates the platform (seconds). No new hardware needed.')
		+ (st.base ? '' : ' Apply saves it as a new configuration.');
	$('apply').disabled = !changed.length || notes.some(n => n[0] === 'err' && n[1] !== 'X-HEEP\\'s generator rejects this configuration:');
	$('revert').disabled = !changed.length;
}

$('cpu').onchange = e => { f.cpu = e.target.value; render(); };
$('fpu').onchange = e => { f.fpu = e.target.checked; render(); };
for (const b of ['onetoM', 'NtoM']) $('bus-' + b).onclick = () => { f.bus = b; render(); };
$('banks-dn').onclick = () => { f.banks = Math.max(1, f.banks - 1); render(); };
$('banks-up').onclick = () => { f.banks = Math.min(32, f.banks + 1); render(); };
$('il-size').onchange = e => { f.ilSizeKb = Number(e.target.value); render(); };
for (const [id, k] of [['code', 'codeKb'], ['stack', 'stackKb'], ['heap', 'heapKb']]) $(id).onchange = e => { f[k] = Math.max(0, Number(e.target.value) || 0); render(); };
$('revert').onclick = () => { f = structuredClone(st.form); error = undefined; render(); };
$('apply').onclick = () => { error = undefined; vscode.postMessage({ type: 'apply', form: f }); };
$('switch').onclick = () => vscode.postMessage({ type: 'switch' });
$('open').onclick = () => vscode.postMessage({ type: 'open' });
vscode.postMessage({ type: 'ready' });
</script></body></html>`;
}

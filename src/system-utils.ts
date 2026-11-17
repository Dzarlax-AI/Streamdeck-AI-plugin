import { spawn } from 'child_process';

export const isMac = process.platform === 'darwin';
const PBCOPY = '/usr/bin/pbcopy';
const PBPASTE = '/usr/bin/pbpaste';
const OSASCRIPT = '/usr/bin/osascript';
const POWERSHELL = `${process.env.SystemRoot || 'C:\\Windows'}/System32/WindowsPowerShell/v1.0/powershell.exe`;
const UTF8_ENV = { ...process.env, LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8' };
const MAX_OUTPUT = 10 * 1024 * 1024;

function run(command: string, args: string[], input?: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const proc = spawn(command, args, { env: isMac ? UTF8_ENV : process.env });
        let output = '';
        let settled = false;
        const finish = (error?: Error) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (error) reject(error); else resolve(output);
        };
        const timer = setTimeout(() => { proc.kill(); finish(new Error('System operation timed out')); }, 5000);
        proc.stderr?.resume();
        proc.stdout?.setEncoding('utf8');
        proc.stdout?.on('data', (chunk: string) => {
            output += chunk;
            if (output.length > MAX_OUTPUT) { proc.kill(); finish(new Error('Clipboard text is too large')); }
        });
        proc.on('error', () => finish(new Error('System operation failed')));
        proc.stdin?.on('error', () => finish(new Error('System operation failed')));
        proc.on('close', (code) => finish(code === 0 ? undefined : new Error('System operation failed')));
        proc.stdin?.end(input, 'utf8');
    });
}

function powershell(script: string, input?: string): Promise<string> {
    return run(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', script], input);
}

export async function copyToClipboard(text: string): Promise<void> {
    if (isMac) await run(PBCOPY, [], text);
    else await powershell('[Console]::InputEncoding = [Text.Encoding]::UTF8; $t = [Console]::In.ReadToEnd(); Set-Clipboard -Value $t -ErrorAction Stop', text);
}

export async function pasteFromClipboard(): Promise<string> {
    if (isMac) return run(PBPASTE, []);
    return powershell('[Console]::OutputEncoding = [Text.Encoding]::UTF8; $t = Get-Clipboard -Raw -ErrorAction Stop; [Console]::Write($t)');
}

async function clipboardRevision(): Promise<string> {
    const output = isMac
        ? await run(OSASCRIPT, ['-l', 'JavaScript', '-e', "ObjC.import('AppKit'); String(ObjC.unwrap($.NSPasteboard.generalPasteboard.changeCount))"])
        : await powershell("Add-Type -MemberDefinition '[DllImport(\"user32.dll\")] public static extern uint GetClipboardSequenceNumber();' -Name Clipboard -Namespace Native; [Console]::Write([Native.Clipboard]::GetClipboardSequenceNumber())");
    const value = output.trim();
    if (!/^\d+$/.test(value) || (!isMac && value === '0')) throw new Error('Cannot read clipboard revision');
    return value;
}

async function winKeyCombo(vkMod: number, vkKey: number): Promise<void> {
    const script = `Add-Type -MemberDefinition '[DllImport("user32.dll")] public static extern void keybd_event(byte k,byte s,uint f,UIntPtr x);' -Name U -Namespace W; [W.U]::keybd_event(${vkMod},0,0,[UIntPtr]::Zero); [W.U]::keybd_event(${vkKey},0,0,[UIntPtr]::Zero); [W.U]::keybd_event(${vkKey},0,2,[UIntPtr]::Zero); [W.U]::keybd_event(${vkMod},0,2,[UIntPtr]::Zero)`;
    await powershell(script);
}

export async function simulateCopy(): Promise<void> {
    if (isMac) await run(OSASCRIPT, ['-e', 'tell application "System Events" to key code 8 using {command down}']);
    else await winKeyCombo(0x11, 0x43);
}

export async function simulatePaste(): Promise<void> {
    if (isMac) await run(OSASCRIPT, ['-e', 'tell application "System Events" to key code 9 using {command down}']);
    else await winKeyCombo(0x11, 0x56);
}

export async function captureSelectedText(): Promise<string> {
    const before = await clipboardRevision();
    await simulateCopy();
    for (let attempt = 0; attempt < 10; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 100));
        const revision = await clipboardRevision();
        if (revision === before) continue;
        const text = await pasteFromClipboard();
        const after = await clipboardRevision();
        if (revision !== after) throw new Error('Clipboard changed during capture');
        if (!text) throw new Error('No text captured from selection');
        return text;
    }
    throw new Error('Copy did not update clipboard');
}

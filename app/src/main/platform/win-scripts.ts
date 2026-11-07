// The PowerShell helpers of the Windows implementations. Each script is plain text run with `-EncodedCommand` (so no quoting of a path with CJK
// characters or a space is ever needed), takes its input from environment variables, and prints only ASCII: names, users, and registry values leave
// as base64 of their UTF-8, so no console code page touches them. Avoid backticks and `${` here: the scripts are String.raw templates.
//
// The three scripts that call Win32 compile their C# once: `NATIVE_SOURCE` is one assembly, built into the app's own helpers folder on first use and loaded
// from there afterwards (`win-helper-cache.ts`; spec: Windows native helper). A script is `prelude + body`: the prelude puts `[SbdNative]` in the session
// (one of the three below), the body is the operation and does not know which prelude ran.

/**
 * The one native helper, as C#. Credentials: `List` and `Delete` for the listing and the sign-out, `Probe` for the store check; `Broadcast` sends WM_SETTINGCHANGE.
 * The struct names `CredentialBlob` as a bare pointer so it has its real size; nothing here reads it, copies it, or follows it, except `Probe`, which reads
 * back the one throwaway secret it wrote itself.
 */
export const NATIVE_SOURCE = String.raw`using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class SbdNative {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct CREDENTIAL {
        public uint Flags;
        public uint Type;
        public string TargetName;
        public string Comment;
        public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
        public uint CredentialBlobSize;
        public IntPtr CredentialBlob;
        public uint Persist;
        public uint AttributeCount;
        public IntPtr Attributes;
        public string TargetAlias;
        public string UserName;
    }

    private const int ERROR_NOT_FOUND = 1168;

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CredEnumerateW(string filter, uint flags, out uint count, out IntPtr credentials);

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CredWriteW(ref CREDENTIAL credential, uint flags);

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CredReadW(string target, uint type, uint flags, out IntPtr credential);

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CredDeleteW(string target, uint type, uint flags);

    [DllImport("advapi32.dll")]
    private static extern void CredFree(IntPtr buffer);

    [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, UIntPtr wParam, string lParam, uint fuFlags, uint uTimeout, out UIntPtr lpdwResult);

    private static string B64(string text) {
        return Convert.ToBase64String(Encoding.UTF8.GetBytes(text == null ? "" : text));
    }

    // One line per generic credential: base64(target) base64(user) LastWritten as a FILETIME in decimal.
    // Only these three fields are copied out; the buffer is freed before the text is returned, and so before anything is printed.
    public static string List(string[] filters) {
        HashSet<string> seen = new HashSet<string>(StringComparer.Ordinal);
        List<string> lines = new List<string>();
        foreach (string filter in filters) {
            uint count;
            IntPtr buffer;
            if (!CredEnumerateW(filter, 0, out count, out buffer)) {
                int error = Marshal.GetLastWin32Error();
                if (error == ERROR_NOT_FOUND) continue;
                throw new System.ComponentModel.Win32Exception(error);
            }
            try {
                for (int i = 0; i < (int)count; i++) {
                    IntPtr item = Marshal.ReadIntPtr(buffer, i * IntPtr.Size);
                    CREDENTIAL c = (CREDENTIAL)Marshal.PtrToStructure(item, typeof(CREDENTIAL));
                    if (c.Type != 1) continue;
                    long ticks = (((long)(uint)c.LastWritten.dwHighDateTime) << 32) | (uint)c.LastWritten.dwLowDateTime;
                    string line = B64(c.TargetName) + " " + B64(c.UserName) + " " + ticks.ToString();
                    if (seen.Add(line)) lines.Add(line);
                }
            } finally {
                CredFree(buffer);
            }
        }
        return string.Join("\n", lines.ToArray());
    }

    // Returns 0 when deleted, else the Win32 error code (1168: no such credential).
    public static int Delete(string target) {
        if (CredDeleteW(target, 1, 0)) return 0;
        return Marshal.GetLastWin32Error();
    }

    // Writes, reads back, and deletes one throwaway credential. Returns "ok" or "fail <step> <Win32 error>".
    public static string Probe(string target) {
        byte[] secret = Encoding.Unicode.GetBytes("straw-boss-desk-probe");
        IntPtr blob = Marshal.AllocHGlobal(secret.Length);
        bool written = false;
        try {
            Marshal.Copy(secret, 0, blob, secret.Length);
            CREDENTIAL c = new CREDENTIAL();
            c.Type = 1;
            c.TargetName = target;
            c.UserName = "straw-boss-desk-probe";
            c.CredentialBlobSize = (uint)secret.Length;
            c.CredentialBlob = blob;
            c.Persist = 2;
            if (!CredWriteW(ref c, 0)) return "fail write " + Marshal.GetLastWin32Error();
            written = true;
            IntPtr read;
            if (!CredReadW(target, 1, 0, out read)) return "fail read " + Marshal.GetLastWin32Error();
            try {
                CREDENTIAL back = (CREDENTIAL)Marshal.PtrToStructure(read, typeof(CREDENTIAL));
                if (back.CredentialBlobSize != (uint)secret.Length) return "fail compare 0";
                byte[] got = new byte[secret.Length];
                Marshal.Copy(back.CredentialBlob, got, 0, got.Length);
                for (int i = 0; i < got.Length; i++) if (got[i] != secret[i]) return "fail compare 0";
            } finally {
                CredFree(read);
            }
            written = false;
            if (!CredDeleteW(target, 1, 0)) return "fail delete " + Marshal.GetLastWin32Error();
            return "ok";
        } finally {
            if (written) CredDeleteW(target, 1, 0);
            Marshal.FreeHGlobal(blob);
        }
    }

    // Tells running programs that the user environment changed (HKCU\Environment), waiting at most 5 s for each.
    public static void Broadcast() {
        UIntPtr result;
        SendMessageTimeout(new IntPtr(0xffff), 0x001A, UIntPtr.Zero, "Environment", 2, 5000, out result);
    }
}`;

/** The exit code of a prelude that could not put `[SbdNative]` in the session from the cached file; the caller deletes that file and runs the build prelude. */
export const HELPER_LOAD_EXIT = 99;
/** The line the load prelude prints to standard error before it exits with `HELPER_LOAD_EXIT`. */
export const HELPER_LOAD_MARKER = "sbd-helper-load-failed";

const SCRIPT_HEAD = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
`;

// No script here calls a cmdlet from a module PowerShell has to find and import (Add-Type, New-Object, Get-CimInstance, Get-Process, Test-Path, ...). Measured on windows-11-arm
// (x64 PowerShell 5.1 under emulation), the first such cmdlet of a process costs 41 to 48 s, whatever it is asked to do: `Get-Command Add-Type` alone took 40.8 s, `Add-Type -LiteralPath`
// of a finished DLL 40.9 s, `New-Object` 48.2 s, `Get-CimInstance` 43.0 s, `Get-Process` 41.4 s; a built-in `ForEach-Object` took 0.03 s, `[Reflection.Assembly]::LoadFrom` 0.03 s,
// the C# compiler through `CSharpCodeProvider` 1.3 s, and a WMI query through `ManagementObjectSearcher` 0.2 s. So these scripts use .NET types and the language only
// (test/win-helper-cache.test.ts keeps it that way). On windows-2025 the same cmdlets cost well under a second, which is why this stayed unseen.

/** Compiles `NATIVE_SOURCE` with the C# compiler of .NET Framework, as `Add-Type` does, but without the cmdlet: to `$Output` when given, else in memory. */
const BUILD_FUNCTION = String.raw`function Build-SbdNative([string]$Source, [string]$Output) {
    $provider = [Microsoft.CSharp.CSharpCodeProvider]::new()
    $options = [System.CodeDom.Compiler.CompilerParameters]::new()
    [void]$options.ReferencedAssemblies.Add('System.dll')
    [void]$options.ReferencedAssemblies.Add('System.Core.dll')
    if ($Output) {
        $options.GenerateInMemory = $false
        $options.OutputAssembly = $Output
    } else {
        $options.GenerateInMemory = $true
    }
    $result = $provider.CompileAssemblyFromSource($options, $Source)
    if ($result.Errors.HasErrors) { throw ('the native helper did not compile: ' + $result.Errors[0].ToString()) }
}
`;

/** A script that never calls the helper: only the head. */
export const NATIVE_PRELUDE_NONE = SCRIPT_HEAD;

/** No cache (no data root given): the C# is compiled in memory on every call. */
export const NATIVE_PRELUDE_MEMORY = `${SCRIPT_HEAD}${BUILD_FUNCTION}$source = @'
${NATIVE_SOURCE}
'@
Build-SbdNative $source ''
`;

/** The cached file exists: load it, and say so by exit code when it will not load (corrupt, locked, from another build). Nothing is compiled. */
export const NATIVE_PRELUDE_LOAD =
	SCRIPT_HEAD +
	String.raw`try {
    [void][Reflection.Assembly]::LoadFrom($env:SBD_HELPER_DLL)
} catch {
}
if (-not ('SbdNative' -as [type])) {
    [Console]::Error.WriteLine('${HELPER_LOAD_MARKER}')
    exit ${HELPER_LOAD_EXIT}
}
`;

/**
 * The cached file is missing (first use, or deleted after a failed load): compile into a temp file beside it and rename that into place, so a reader
 * never sees a half-written file. Any failure of the caching itself (a folder that cannot be written, a lost race for the name) leaves the types in
 * the session some other way: loaded from the file that exists, else compiled in memory, so the script's result does not depend on the cache.
 */
export const NATIVE_PRELUDE_BUILD =
	SCRIPT_HEAD +
	BUILD_FUNCTION +
	`$source = @'
${NATIVE_SOURCE}
'@
` +
	String.raw`$dll = $env:SBD_HELPER_DLL
try {
    $dir = [IO.Path]::GetDirectoryName($dll)
    [void][IO.Directory]::CreateDirectory($dir)
    foreach ($old in [IO.Directory]::GetFiles($dir, 'sbd-tmp-*.dll')) {
        if (([DateTime]::UtcNow - [IO.File]::GetLastWriteTimeUtc($old)).TotalMinutes -gt 10) {
            try { [IO.File]::Delete($old) } catch { }
        }
    }
    $tmp = [IO.Path]::Combine($dir, 'sbd-tmp-' + [Guid]::NewGuid().ToString('N') + '.dll')
    Build-SbdNative $source $tmp
    try { [IO.File]::Move($tmp, $dll) } catch { try { [IO.File]::Copy($tmp, $dll, $false) } catch { } }
    try { [IO.File]::Delete($tmp) } catch { }
} catch {
}
if (-not ('SbdNative' -as [type])) {
    try { [void][Reflection.Assembly]::LoadFrom($dll) } catch { }
}
if (-not ('SbdNative' -as [type])) {
    Build-SbdNative $source ''
}
`;

/** Lists, and deletes, generic credentials. Nothing in this script reads a credential's secret, copies it, or follows its pointer. */
export const CREDENTIAL_LIST_BODY = String.raw`
$op = $env:SBD_OP
if ($op -eq 'list') {
    $filters = $env:SBD_FILTERS -split '\|'
    [Console]::Out.Write([SbdNative]::List($filters))
} elseif ($op -eq 'delete') {
    $target = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:SBD_TARGET))
    [Console]::Out.Write([string][SbdNative]::Delete($target))
} else {
    throw 'unknown operation'
}
`;

/** The store probe: writes, reads back, and deletes one throwaway generic credential of its own. Prints `ok` or `fail <step> <Win32 error>`. */
export const CREDENTIAL_PROBE_BODY = String.raw`
[Console]::Out.Write([SbdNative]::Probe($env:SBD_TARGET))
`;

/** Reads, writes, and deletes the `Path` value of one HKCU subkey (default `Environment`), keeping its registry type and every %VAR% entry as written. The write and delete ask for `SbdNative` only when they broadcast. */
export const USER_PATH_BODY = String.raw`
$sub = $env:SBD_KEY
$op = $env:SBD_OP
$hkcu = [Microsoft.Win32.Registry]::CurrentUser
if ($op -eq 'read') {
    $key = $hkcu.OpenSubKey($sub, $false)
    $answer = 'none'
    if ($key -ne $null) {
        try {
            $has = $false
            foreach ($n in $key.GetValueNames()) { if ($n -ieq 'Path') { $has = $true } }
            if ($has) {
                $kind = $key.GetValueKind('Path').ToString()
                $value = [string]$key.GetValue('Path', $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
                $answer = $kind + ' ' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($value))
            }
        } finally {
            $key.Close()
        }
    }
    [Console]::Out.Write($answer)
} else {
    if ($op -eq 'write') {
        $value = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:SBD_VALUE))
        $kind = [Microsoft.Win32.RegistryValueKind]::ExpandString
        if ($env:SBD_KIND -eq 'String') { $kind = [Microsoft.Win32.RegistryValueKind]::String }
        $key = $hkcu.CreateSubKey($sub)
        try { $key.SetValue('Path', $value, $kind) } finally { $key.Close() }
    } elseif ($op -eq 'delete') {
        $key = $hkcu.OpenSubKey($sub, $true)
        if ($key -ne $null) {
            try { $key.DeleteValue('Path', $false) } finally { $key.Close() }
        }
    } else {
        throw 'unknown operation'
    }
    if ($env:SBD_BROADCAST -eq '1') {
        [SbdNative]::Broadcast()
    }
    [Console]::Out.Write('ok')
}
`;

/**
 * Start time and executable of processes: Win32_Process reads ProcessId, ExecutablePath, and CreationDate only, never a command line. It queries WMI through
 * `System.Management` and reads the creation date's DMTF text itself (`yyyymmddHHMMSS.ffffff+UUU`, UUU the offset in minutes), which gives the instant `Get-CimInstance` gave,
 * to the microsecond, in UTC with seven fraction digits. It compiles nothing and calls no cmdlet.
 */
export const PROCESS_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[void][Reflection.Assembly]::Load('System.Management, Version=4.0.0.0, Culture=neutral, PublicKeyToken=b03f5f7f11d50a3a')
$wanted = [System.Collections.Generic.HashSet[int]]::new()
if ($env:SBD_PIDS) {
    foreach ($token in $env:SBD_PIDS.Split(',')) { [void]$wanted.Add([int]$token) }
}
$lines = [System.Collections.Generic.List[string]]::new()
$searcher = [System.Management.ManagementObjectSearcher]::new('SELECT ProcessId,ExecutablePath,CreationDate FROM Win32_Process')
try {
    foreach ($p in $searcher.Get()) {
        $id = [int]$p.Properties['ProcessId'].Value
        if ($env:SBD_PIDS -and -not $wanted.Contains($id)) { continue }
        $exe = ''
        $path = $p.Properties['ExecutablePath'].Value
        if ($path) { $exe = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([string]$path)) }
        $started = ''
        $created = $p.Properties['CreationDate'].Value
        if ($created) {
            $text = [string]$created
            $utc = [DateTime]::new([int]$text.Substring(0, 4), [int]$text.Substring(4, 2), [int]$text.Substring(6, 2), [int]$text.Substring(8, 2), [int]$text.Substring(10, 2), [int]$text.Substring(12, 2), [DateTimeKind]::Utc)
            $utc = $utc.AddTicks([long]$text.Substring(15, 6) * 10).AddMinutes(-[int]$text.Substring(21))
            $started = $utc.ToString('o')
        }
        $lines.Add(([string]$id) + ' ' + $exe + ' ' + $started)
        $p.Dispose()
    }
} finally {
    $searcher.Dispose()
}
[Console]::Out.Write([string]::Join([string][char]10, $lines))
`;

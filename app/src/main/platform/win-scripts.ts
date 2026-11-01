// The PowerShell helpers of the Windows implementations. Each script is plain text run with `-EncodedCommand` (so no quoting of a path with CJK
// characters or a space is ever needed), takes its input from environment variables, and prints only ASCII: names, users, and registry values leave
// as base64 of their UTF-8, so no console code page touches them. Avoid backticks and `${` here: the scripts are String.raw templates.

/** Lists, and deletes, generic credentials. The C# struct names `CredentialBlob` as a bare pointer so it has its real size; nothing in this script reads it, copies it, or follows it. */
export const CREDENTIAL_LIST_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class SbdCredentials {
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
    private static extern bool CredDeleteW(string target, uint type, uint flags);

    [DllImport("advapi32.dll")]
    private static extern void CredFree(IntPtr buffer);

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
}
'@
$op = $env:SBD_OP
if ($op -eq 'list') {
    $filters = $env:SBD_FILTERS -split '\|'
    [Console]::Out.Write([SbdCredentials]::List($filters))
} elseif ($op -eq 'delete') {
    $target = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:SBD_TARGET))
    [Console]::Out.Write([string][SbdCredentials]::Delete($target))
} else {
    throw 'unknown operation'
}
`;

/** The store probe: writes, reads back, and deletes one throwaway generic credential of its own. Prints `ok` or `fail <step> <Win32 error>`. */
export const CREDENTIAL_PROBE_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class SbdProbe {
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

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CredWriteW(ref CREDENTIAL credential, uint flags);

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CredReadW(string target, uint type, uint flags, out IntPtr credential);

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CredDeleteW(string target, uint type, uint flags);

    [DllImport("advapi32.dll")]
    private static extern void CredFree(IntPtr buffer);

    public static string Run(string target) {
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
}
'@
[Console]::Out.Write([SbdProbe]::Run($env:SBD_TARGET))
`;

/** Reads, writes, and deletes the `Path` value of one HKCU subkey (default `Environment`), keeping its registry type and every %VAR% entry as written. */
export const USER_PATH_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
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
        Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class SbdBroadcast {
    [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, UIntPtr wParam, string lParam, uint fuFlags, uint uTimeout, out UIntPtr lpdwResult);
}
'@
        $result = [UIntPtr]::Zero
        [void][SbdBroadcast]::SendMessageTimeout([IntPtr]0xffff, 0x001A, [UIntPtr]::Zero, 'Environment', 2, 5000, [ref]$result)
    }
    [Console]::Out.Write('ok')
}
`;

/** Start time and executable of processes: Win32_Process reads ProcessId, ExecutablePath, and CreationDate only, never a command line. */
export const PROCESS_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$wanted = @()
if ($env:SBD_PIDS) { $wanted = @($env:SBD_PIDS -split ',' | ForEach-Object { [int]$_ }) }
$lines = New-Object System.Collections.ArrayList
foreach ($p in (Get-CimInstance -ClassName Win32_Process -Property ProcessId,ExecutablePath,CreationDate)) {
    if ($env:SBD_PIDS -and ($wanted -notcontains [int]$p.ProcessId)) { continue }
    $exe = ''
    if ($p.ExecutablePath) { $exe = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([string]$p.ExecutablePath)) }
    $started = ''
    if ($p.CreationDate) { $started = $p.CreationDate.ToUniversalTime().ToString('o') }
    [void]$lines.Add(([string]$p.ProcessId) + ' ' + $exe + ' ' + $started)
}
[Console]::Out.Write(($lines -join [string][char]10))
`;

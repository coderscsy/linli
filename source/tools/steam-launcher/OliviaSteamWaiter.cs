using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Management;
using System.Threading;
using System.Windows.Forms;

internal sealed class LaunchTarget
{
    internal string LauncherPath;
    internal string OliviaPath;
}

internal sealed class ProcessIdentity
{
    internal int Id;
    internal DateTime StartedUtc;
    internal Process Process;
}

internal static class WaiterCore
{
    internal static int Run(string[] arguments, out string error, int discoveryMilliseconds)
    {
        error = null;
        LaunchTarget target;
        if (!TryResolve(arguments, out target, out error)) return 2;

        bool inspectionFailed;
        Dictionary<int, ProcessIdentity> before = FindMainProcesses(target.OliviaPath, out inspectionFailed);
        if (before.Count > 1) { error = "More than one matching Olivia process is already running."; return 3; }

        Process launcher;
        try
        {
            launcher = Process.Start(new ProcessStartInfo(target.LauncherPath, Quote(arguments, 1)) {
                UseShellExecute = false,
                WorkingDirectory = Path.GetDirectoryName(target.LauncherPath)
            });
        }
        catch { error = "The official launcher could not be started."; return 4; }

        ProcessIdentity selected = before.Count == 1 ? First(before) : null;
        DateTime deadline = DateTime.UtcNow.AddMilliseconds(discoveryMilliseconds);
        while (selected == null && DateTime.UtcNow < deadline)
        {
            if (launcher.HasExited && launcher.ExitCode != 0)
            {
                launcher.Dispose();
                error = "The official launcher reported a failure.";
                return 6;
            }
            bool scanInspectionFailed;
            Dictionary<int, ProcessIdentity> current = FindMainProcesses(target.OliviaPath, out scanInspectionFailed);
            inspectionFailed = inspectionFailed || scanInspectionFailed;
            List<ProcessIdentity> fresh = new List<ProcessIdentity>();
            foreach (ProcessIdentity candidate in current.Values)
            {
                ProcessIdentity old;
                if (!before.TryGetValue(candidate.Id, out old) || old.StartedUtc != candidate.StartedUtc) fresh.Add(candidate);
            }
            if (fresh.Count > 1) { Dispose(current); error = "More than one new matching Olivia process was found."; return 5; }
            if (fresh.Count == 1) selected = fresh[0];
            DisposeExcept(current, selected);
            if (selected == null) Thread.Sleep(100);
        }

        launcher.Dispose();
        if (selected == null) { error = inspectionFailed ? "A matching Olivia process could not be safely inspected." : "The official launcher ended without starting Olivia."; return 6; }

        try { selected.Process.WaitForExit(); }
        catch { error = "The Olivia process could not be observed."; return 7; }
        finally { selected.Process.Dispose(); }
        return 0;
    }

    internal static int Run(string[] arguments, out string error) { return Run(arguments, out error, 30000); }

    private static bool TryResolve(string[] arguments, out LaunchTarget target, out string error)
    {
        target = null; error = null;
        if (arguments == null || arguments.Length == 0 || String.IsNullOrWhiteSpace(arguments[0])) { error = "An official launcher path is required."; return false; }
        string raw = arguments[0];
        if (!IsAbsoluteWindowsPath(raw)) { error = "The official launcher path must be absolute."; return false; }
        string launcher;
        try { launcher = Path.GetFullPath(arguments[0]); }
        catch { error = "The official launcher path is invalid."; return false; }
        if (!File.Exists(launcher) || !String.Equals(Path.GetFileName(launcher), "launcher.exe", StringComparison.OrdinalIgnoreCase)) { error = "The official launcher.exe was not found."; return false; }
        FileVersionInfo v = FileVersionInfo.GetVersionInfo(launcher);
        if (v.ProductMajorPart < 0 || v.ProductMinorPart < 0 || v.ProductBuildPart < 0 || v.ProductPrivatePart < 0) { error = "The official launcher has no numeric ProductVersion."; return false; }
        string version = v.ProductMajorPart + "." + v.ProductMinorPart + "." + v.ProductBuildPart + "." + v.ProductPrivatePart;
        string olivia = Path.Combine(Path.GetDirectoryName(launcher), version, "Olivia.exe");
        if (!File.Exists(olivia)) { error = "The matching Olivia.exe was not found."; return false; }
        target = new LaunchTarget { LauncherPath = launcher, OliviaPath = Path.GetFullPath(olivia) };
        return true;
    }

    private static bool IsAbsoluteWindowsPath(string path)
    {
        if (path.Length >= 3 && Char.IsLetter(path[0]) && path[1] == ':' && (path[2] == '\\' || path[2] == '/')) return true;
        return path.Length >= 5 && path[0] == '\\' && path[1] == '\\' && path[2] != '\\' && path[2] != '/' && path.IndexOf('\\', 2) > 2;
    }

    private static Dictionary<int, ProcessIdentity> FindMainProcesses(string exactPath, out bool inspectionFailed)
    {
        inspectionFailed = false;
        var matches = new Dictionary<int, ProcessIdentity>();
        foreach (Process process in Process.GetProcessesByName(Path.GetFileNameWithoutExtension(exactPath)))
        {
            try
            {
                IntPtr retainedHandle = process.Handle;
                if (retainedHandle == IntPtr.Zero) { process.Dispose(); continue; }
                string image = process.MainModule.FileName;
                DateTime started = process.StartTime.ToUniversalTime();
                if (!String.Equals(Path.GetFullPath(image), exactPath, StringComparison.OrdinalIgnoreCase)) { process.Dispose(); continue; }
                CandidateKind kind = InspectCandidate(process.Id);
                if (kind != CandidateKind.Main) { if (kind == CandidateKind.Unknown) inspectionFailed = true; process.Dispose(); continue; }
                matches.Add(process.Id, new ProcessIdentity { Id = process.Id, StartedUtc = started, Process = process });
            }
            catch { process.Dispose(); }
        }
        return matches;
    }

    internal enum CandidateKind { Main, Cef, Unknown }
    internal static CandidateKind ClassifyCommandLine(string commandLine)
    {
        if (commandLine == null) return CandidateKind.Unknown;
        return commandLine.IndexOf("--type=", StringComparison.OrdinalIgnoreCase) >= 0 ? CandidateKind.Cef : CandidateKind.Main;
    }
    private static CandidateKind InspectCandidate(int pid)
    {
        try
        {
            using (var searcher = new ManagementObjectSearcher(new ManagementScope(), new ObjectQuery("SELECT CommandLine FROM Win32_Process WHERE ProcessId=" + pid), new EnumerationOptions { Timeout = TimeSpan.FromSeconds(1) }))
            using (var rows = searcher.Get())
                foreach (ManagementObject row in rows)
                {
                    string commandLine = row["CommandLine"] as string;
                    return ClassifyCommandLine(commandLine);
                }
        }
        catch { return CandidateKind.Unknown; }
        return CandidateKind.Unknown;
    }

    private static ProcessIdentity First(Dictionary<int, ProcessIdentity> values) { foreach (ProcessIdentity value in values.Values) return value; return null; }
    private static void Dispose(Dictionary<int, ProcessIdentity> values) { foreach (ProcessIdentity value in values.Values) value.Process.Dispose(); }
    private static void DisposeExcept(Dictionary<int, ProcessIdentity> values, ProcessIdentity retained) { foreach (ProcessIdentity value in values.Values) if (retained == null || value.Id != retained.Id) value.Process.Dispose(); }

    internal static string Quote(string[] values, int start)
    {
        string result = "";
        for (int i = start; i < values.Length; i++) result += (result.Length == 0 ? "" : " ") + QuoteOne(values[i] ?? "");
        return result;
    }
    private static string QuoteOne(string value)
    {
        var text = new System.Text.StringBuilder("\""); int slashes = 0;
        foreach (char c in value)
        {
            if (c == '\\') { slashes++; continue; }
            if (c == '\"') { text.Append('\\', slashes * 2 + 1); text.Append(c); slashes = 0; continue; }
            text.Append('\\', slashes); slashes = 0; text.Append(c);
        }
        text.Append('\\', slashes * 2); text.Append('\"'); return text.ToString();
    }
}

internal static class Program
{
    [STAThread]
    private static int Main(string[] args)
    {
        string error; int code = WaiterCore.Run(args, out error);
        if (code != 0)
            MessageBox.Show(error, "Olivia Steam launch", MessageBoxButtons.OK, MessageBoxIcon.Error);
        return code;
    }
}

using System;
using System.Diagnostics;
using System.IO;
using System.Threading;

[assembly: System.Reflection.AssemblyFileVersion("1.2.3.4")]
[assembly: System.Reflection.AssemblyVersion("1.2.3.4")]

internal static class FakeLauncher
{
    private static int Main(string[] args)
    {
        // child-delay-ms, child-lifetime-ms, launcher-exit-code, optional argument capture file, then forwarded values
        int delay = Int32.Parse(args[0]);
        int lifetime = Int32.Parse(args[1]);
        int exitCode = Int32.Parse(args[2]);
        if (args.Length > 3 && args[3] != "-") File.WriteAllLines(args[3], args, System.Text.Encoding.UTF8);
        if (exitCode == -1)
        {
            Thread.Sleep(2000);
            return 0;
        }
        if (exitCode == 0 || exitCode == -2)
        {
            if (delay > 0) Thread.Sleep(delay);
            string child = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "1.2.3.4", "Olivia.exe");
            Process.Start(new ProcessStartInfo(child, lifetime.ToString()) { UseShellExecute = false, WorkingDirectory = AppDomain.CurrentDomain.BaseDirectory });
            if (exitCode == -2) Thread.Sleep(2000);
        }
        return exitCode;
    }
}

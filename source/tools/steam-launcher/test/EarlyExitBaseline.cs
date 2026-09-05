using System;
using System.Diagnostics;
using System.IO;
using System.Threading;

// Deliberately naive baseline: the historical behavior is to wait only launcher.exe.
internal static class EarlyExitBaseline
{
    private static int Main()
    {
        string root = Path.Combine(Environment.GetEnvironmentVariable("OLIVIA_STEAM_WAITER_TEST_ROOT") ?? Path.GetTempPath(), "baseline-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(Path.Combine(root, "1.2.3.4"));
        File.Copy(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "FakeLauncher.exe"), Path.Combine(root, "launcher.exe"));
        File.Copy(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "FakeOlivia.exe"), Path.Combine(root, "1.2.3.4", "Olivia.exe"));
        Process launcher = Process.Start(new ProcessStartInfo(Path.Combine(root, "launcher.exe"), "0 1200 0 -") { UseShellExecute = false });
        launcher.WaitForExit(); Thread.Sleep(200);
        bool regression = launcher.HasExited && Process.GetProcessesByName("Olivia").Length > 0;
        launcher.Dispose();
        Thread.Sleep(1100);
        try { Directory.Delete(root, true); } catch { }
        Console.WriteLine(regression ? "FAIL baseline exits while Olivia is alive" : "unexpected baseline result");
        return regression ? 1 : 2;
    }
}

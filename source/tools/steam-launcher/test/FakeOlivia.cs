using System;
using System.Threading;

internal static class FakeOlivia
{
    private static int Main(string[] args)
    {
        int milliseconds = args.Length == 0 || args[0].StartsWith("--type=") ? 1500 : Int32.Parse(args[0]);
        Thread.Sleep(milliseconds);
        return 0;
    }
}

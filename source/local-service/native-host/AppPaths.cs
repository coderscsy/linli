using System;
using System.IO;

namespace OliviaSoul
{
    public sealed class AppPaths
    {
        public string BaseDirectory { get; private set; }
        public string UserData { get; private set; }
        public string Workspace { get; private set; }
        public string Data { get; private set; }
        public string Template { get; private set; }
        public string NodeExecutable { get; private set; }
        public string NodeHostScript { get; private set; }
        public string GameUserSettings { get; private set; }

        public static AppPaths Detect()
        {
            var baseDirectory = AppDomain.CurrentDomain.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar);
            var packaged = File.Exists(Path.Combine(baseDirectory, "runtime", "node.exe"));
            var localService = packaged ? null : Path.GetFullPath(Path.Combine(baseDirectory, "..", "..", "..", ".."));
            var repositoryRoot = packaged ? null : Path.GetFullPath(Path.Combine(localService, ".."));
            var roamingData = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
            var userData = Path.Combine(baseDirectory, "UserData");
            Directory.CreateDirectory(userData);
            Directory.CreateDirectory(Path.Combine(userData, "database"));
            return new AppPaths
            {
                BaseDirectory = baseDirectory,
                UserData = userData,
                Workspace = userData,
                Data = Path.Combine(userData, "database"),
                Template = packaged
                    ? Path.Combine(baseDirectory, "resources", "workspace-template")
                    : repositoryRoot,
                NodeExecutable = packaged ? Path.Combine(baseDirectory, "runtime", "node.exe") : "node.exe",
                NodeHostScript = packaged
                    ? Path.Combine(baseDirectory, "app", "desktop", "node-host.js")
                    : Path.Combine(localService, "desktop", "node-host.js"),
                GameUserSettings = Path.Combine(roamingData, "miHoYo", "Olivia-steam", "store", "usersettings.dat"),
            };
        }
    }
}

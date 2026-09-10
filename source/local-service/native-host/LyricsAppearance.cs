using System;
using System.Drawing.Text;
using System.Linq;

namespace OliviaSoul {
    public static class LyricsAppearance {
        public static string[] InstalledFonts() {
            using (var collection = new InstalledFontCollection()) {
                var families = collection.Families;
                try { return families.Select(f => f.Name).Distinct().OrderBy(n => n).ToArray(); }
                finally { foreach (var family in families) family.Dispose(); }
            }
        }
        public static string Resolve(string requested) {
            var fonts = InstalledFonts();
            if (requested != "auto" && fonts.Contains(requested)) return requested;
            foreach (var name in new[] { "SentyTEA", "新蒂下午茶体", "汉仪新蒂下午茶体", "Hanyi Senty Tea", "楷体", "KaiTi", "Microsoft YaHei UI" })
                if (fonts.Contains(name)) return name;
            return System.Drawing.SystemFonts.DefaultFont.Name;
        }
    }
}

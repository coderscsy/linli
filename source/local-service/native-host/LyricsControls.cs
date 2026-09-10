using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Windows.Forms;

namespace OliviaSoul
{
    // Menu and toolbar own no playback state and never send player commands.
    internal sealed class LyricsControls : IDisposable
    {
        public readonly ToolStrip Strip = new PointerToolStrip { GripStyle = ToolStripGripStyle.Hidden, Dock = DockStyle.None, CanOverflow = false, ShowItemToolTips = false };
        private sealed class PointerToolStrip : ToolStrip {
            protected override void WndProc(ref Message m) {
                // Bypass ToolStrip's activation bookkeeping: the first press is an action,
                // not a request to activate this intentionally nonactivating window.
                if (m.Msg == 0x21) { m.Result = (IntPtr)3; return; }
                base.WndProc(ref m);
                if (m.Msg == 0x20) {
                    var item = GetItemAt(PointToClient(System.Windows.Forms.Cursor.Position));
                    System.Windows.Forms.Cursor.Current = item is ToolStripButton && item.Enabled ? Cursors.Hand : item == null ? Cursors.SizeAll : Cursors.Arrow;
                    m.Result = (IntPtr)1;
                }
            }
        }
        private readonly HintWindow _hint = new HintWindow();
        private sealed class HintWindow : Form {
            private readonly Label _text = new Label { AutoSize = true, BackColor = Color.FromArgb(255, 250, 231), ForeColor = Color.FromArgb(38, 35, 31), Padding = new Padding(8, 5, 8, 5) };
            internal HintWindow() {
                FormBorderStyle = FormBorderStyle.None; ShowInTaskbar = false; TopMost = true;
                StartPosition = FormStartPosition.Manual; BackColor = _text.BackColor;
                // WS_EX_TRANSPARENT only guarantees cross-window click-through on a layered window.
                // Keep this tooltip layered independently of the fully opaque toolbar.
                Opacity = 0.99;
                Controls.Add(_text);
            }
            protected override bool ShowWithoutActivation { get { return true; } }
            protected override CreateParams CreateParams {
                get { var p = base.CreateParams; p.ExStyle |= 0x08000000 | 0x80 | 0x20; return p; }
            }
            internal void Present(string text, ToolStrip strip, Point pointer) {
                _text.Text = text; ClientSize = _text.PreferredSize;
                Location = HintPosition(pointer, Size, Screen.FromPoint(pointer).WorkingArea);
                if (!Visible) Show();
            }
            protected override void WndProc(ref Message m) {
                if (m.Msg == 0x21) { m.Result = (IntPtr)3; return; }
                if (m.Msg == 0x84) { m.Result = (IntPtr)(-1); return; }
                base.WndProc(ref m);
            }
        }
        private readonly Timer _hintDelay = new Timer { Interval = 400 };
        private bool _disposed;
        private ToolStripItem _hovered;
        public readonly ContextMenuStrip Menu = new ContextMenuStrip();
        private readonly ToolStripButton _resetOffset;
        private readonly ToolStripButton _direction;
        private readonly ToolStripButton _playback;
        private bool _paused;
        internal event Action<string> PlaybackRequested;
        private readonly ToolStripMenuItem _single, _double, _bold, _animate;
        private readonly Action<string, object> _change;
        private Color _currentColor = Color.FromArgb(255, 235, 170), _nextColor = Color.White;
        private bool _isBold, _isAnimated = true;
        private bool _vertical;
        public LyricsControls(Action<int> resize, Action<int, bool> offset, Action<string, object> change, Action settings)
        {
            _change = change;
            _hintDelay.Tick += (s, e) => ShowHint();
            Strip.MouseMove += Hover;
            Strip.MouseLeave += (s, e) => HideHint();
            Strip.MouseDown += (s, e) => HideHint();
            Strip.VisibleChanged += (s, e) => { if (!Strip.Visible) HideHint(); };
            Strip.BackColor = Menu.BackColor = Color.FromArgb(35, 37, 40);
            Strip.Padding = new Padding(8, 4, 8, 4);
            Strip.ForeColor = Menu.ForeColor = Color.FromArgb(235, 230, 219);
            Menu.Renderer = new ToolStripProfessionalRenderer(new DarkColors());
            Strip.Renderer = new GlassRenderer();
            Strip.SizeChanged += (s, e) => {
                if (Strip.Width < 4 || Strip.Height < 4) return;
                using (var path = Rounded(new Rectangle(0, 0, Strip.Width, Strip.Height), 9)) {
                    var previous = Strip.Region; Strip.Region = new Region(path); previous?.Dispose();
                }
            };
            Button("\uE892", "上一曲", () => PlaybackRequested?.Invoke("previous"));
            _playback = Button("\uE769", "暂停播放", () => PlaybackRequested?.Invoke(_paused ? "resume" : "pause"));
            Button("\uE893", "下一曲", () => PlaybackRequested?.Invoke("next"));
            Button("\uE71F", "缩小歌词", () => resize(-2));
            Button("\uE8A3", "放大歌词", () => resize(2));
            Button("\uE72B", "延后 0.5 秒", () => offset(500, false));
            Button("\uE72A", "提前 0.5 秒", () => offset(-500, false));
            _resetOffset = Button("\uE777", "偏移归零", () => offset(0, true));
            _direction = Button("\uE7AD", "切换为竖排歌词", () => change("orientation", _vertical ? "horizontal" : "vertical"));
            Button("\uE713", "更多歌词设置", settings);
            Button("\uE72E", "锁定歌词位置", () => change("locked", true));
            Button("\uE711", "关闭歌词，不停止音乐", () => change("enabled", false));

            Item(Menu.Items, "放大歌词", () => resize(2));
            Item(Menu.Items, "缩小歌词", () => resize(-2));
            var colors = Item(Menu.Items, "字体颜色", null);
            Item(colors.DropDownItems, "暖金", () => change("currentColor", "#ffebaa"));
            Item(colors.DropDownItems, "海洋蓝", () => change("currentColor", "#00c8ef"));
            Item(colors.DropDownItems, "清绿", () => change("currentColor", "#80efbd"));
            Item(colors.DropDownItems, "纯白", () => change("currentColor", "#ffffff"));
            colors.DropDownItems.Add(new ToolStripSeparator());
            Item(colors.DropDownItems, "自定义当前句…", () => ChooseColor("currentColor", _currentColor));
            Item(colors.DropDownItems, "自定义下一句…", () => ChooseColor("nextColor", _nextColor));
            Menu.Items.Add(new ToolStripSeparator());
            _single = Item(Menu.Items, "单行歌词", () => change("lineMode", "single"));
            _double = Item(Menu.Items, "双行歌词", () => change("lineMode", "double"));
            _bold = Item(Menu.Items, "粗体", () => change("fontWeight", _isBold ? "normal" : "bold"));
            _animate = Item(Menu.Items, "换句渐显", () => change("animate", !_isAnimated));
            Menu.Items.Add(new ToolStripSeparator());
            var operations = Item(Menu.Items, "歌词操作", null);
            Item(operations.DropDownItems, "提前 0.5 秒", () => offset(-500, false));
            Item(operations.DropDownItems, "延后 0.5 秒", () => offset(500, false));
            Item(operations.DropDownItems, "偏移归零", () => offset(0, true));
            Item(Menu.Items, "锁定位置 / 鼠标穿透", () => change("locked", true));
            Menu.Items.Add(new ToolStripSeparator());
            Item(Menu.Items, "更多设置（字体 / 透明度）", settings);
            Item(Menu.Items, "恢复外观默认", () => change("resetAppearance", true));
            Item(Menu.Items, "关闭歌词", () => change("enabled", false));
        }
        private ToolStripButton Button(string glyph, string hint, Action action) {
            var item = new ToolStripButton { ToolTipText = hint, AccessibleName = hint, DisplayStyle = ToolStripItemDisplayStyle.Image, Image = Icon(glyph), ImageScaling = ToolStripItemImageScaling.None, AutoSize = false, Size = new Size(30, 30), Padding = Padding.Empty, Margin = new Padding(2) };
            item.MouseEnter += (s, e) => HoverItem(item);
            item.MouseLeave += (s, e) => HideHint();
            item.MouseDown += (s, e) => HideHint();
            item.Click += (s, e) => action(); Strip.Items.Add(item); return item;
        }
        private void HideHint() {
            if (_disposed) return;
            _hintDelay.Stop();
            _hint.Hide(); _hovered = null; Strip.Cursor = Cursors.Arrow;
        }
        private void Hover(object sender, MouseEventArgs e) {
            HoverItem(Strip.GetItemAt(e.Location));
        }
        private void HoverItem(ToolStripItem item) {
            bool clickable = item is ToolStripButton && item.Enabled;
            if (item == _hovered) {
                Strip.Cursor = clickable ? Cursors.Hand : item == null ? Cursors.SizeAll : Cursors.Arrow;
                if (clickable && _hint.Visible) _hint.Present(item.ToolTipText, Strip, Cursor.Position);
                return;
            }
            _hintDelay.Stop(); _hint.Hide(); _hovered = item;
            Strip.Cursor = clickable ? Cursors.Hand : item == null ? Cursors.SizeAll : Cursors.Arrow;
            if (!clickable || string.IsNullOrEmpty(item.ToolTipText)) return;
            _hintDelay.Start();
        }
        private void ShowHint() {
            _hintDelay.Stop();
            if (_disposed || !Strip.Visible || _hovered == null) return;
            var pointer = Cursor.Position;
            if (Strip.GetItemAt(Strip.PointToClient(pointer)) != _hovered) return;
            _hint.Present(_hovered.ToolTipText, Strip, pointer);
        }
        internal static Point HintPosition(Point pointer, Size hint, Rectangle screen) {
            int x = pointer.X + 8;
            int y = pointer.Y + 24;
            if (y + hint.Height > screen.Bottom) y = pointer.Y - hint.Height - 12;
            return new Point(Math.Max(screen.Left, Math.Min(x, screen.Right - hint.Width)),
                Math.Max(screen.Top, Math.Min(y, screen.Bottom - hint.Height)));
        }
        private ToolStripMenuItem Item(ToolStripItemCollection items, string text, Action action) {
            var item = new ToolStripMenuItem(text) { BackColor = Menu.BackColor, ForeColor = Menu.ForeColor };
            if (action != null) item.Click += (s, e) => action();
            items.Add(item); return item;
        }
        private void ChooseColor(string key, Color color) {
            using (var dialog = new ColorDialog { Color = color, FullOpen = true }) {
                if (dialog.ShowDialog() == DialogResult.OK) _change(key, "#" + dialog.Color.R.ToString("x2") + dialog.Color.G.ToString("x2") + dialog.Color.B.ToString("x2"));
            }
        }
        public void Configure(bool single, bool bold, bool animate, Color current, Color next) {
            _single.Checked = single; _double.Checked = !single;
            _bold.Checked = _isBold = bold; _animate.Checked = _isAnimated = animate;
            _currentColor = current; _nextColor = next;
        }
        public void Offset(int milliseconds) { _resetOffset.ToolTipText = "偏移归零（当前 " + (milliseconds > 0 ? "+" : "") + milliseconds + " ms）"; }
        public void Playback(bool paused, bool busy, string error) {
            if (_paused != paused) { var old = _playback.Image; _playback.Image = Icon(paused ? "\uE768" : "\uE769"); old?.Dispose(); }
            _paused = paused;
            _playback.ToolTipText = _playback.AccessibleName = error ?? (paused ? "继续播放" : "暂停播放");
            for (int i=0;i<3;i++) Strip.Items[i].Enabled = !busy;
        }
        internal static Bitmap LockIcon(bool open) { return Icon(open ? "\uE785" : "\uE72E"); }
        private static Bitmap Icon(string glyph) {
            var bitmap = new Bitmap(24, 24);
            // Windows-provided icon font; no font file is copied or bundled.
            using (var g = Graphics.FromImage(bitmap)) using (var font = new Font("Segoe MDL2 Assets", 18, FontStyle.Regular, GraphicsUnit.Pixel))
            using (var brush = new SolidBrush(Color.Gainsboro)) using (var format = new StringFormat { Alignment = StringAlignment.Center, LineAlignment = StringAlignment.Center }) {
                g.TextRenderingHint = System.Drawing.Text.TextRenderingHint.AntiAliasGridFit;
                g.DrawString(glyph, font, brush, new RectangleF(0, 0, 24, 24), format);
            }
            return bitmap;
        }
        internal static GraphicsPath Rounded(Rectangle bounds, int radius) {
            var path = new GraphicsPath(); int d = Math.Min(radius * 2, Math.Min(bounds.Width, bounds.Height));
            path.AddArc(bounds.Left, bounds.Top, d, d, 180, 90); path.AddArc(bounds.Right - d, bounds.Top, d, d, 270, 90);
            path.AddArc(bounds.Right - d, bounds.Bottom - d, d, d, 0, 90); path.AddArc(bounds.Left, bounds.Bottom - d, d, d, 90, 90); path.CloseFigure(); return path;
        }
        private sealed class GlassRenderer : ToolStripProfessionalRenderer {
            public GlassRenderer() : base(new DarkColors()) { }
            protected override void OnRenderToolStripBackground(ToolStripRenderEventArgs e) {
                var bounds = new Rectangle(1, 1, e.ToolStrip.Width - 3, e.ToolStrip.Height - 3);
                if (bounds.Width < 2 || bounds.Height < 2) return;
                e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
                using (var path = Rounded(bounds, 7)) using (var fill = new LinearGradientBrush(bounds, Color.FromArgb(49, 49, 52), Color.FromArgb(25, 25, 28), 90f)) using (var edge = new Pen(Color.FromArgb(95, 95, 100))) {
                    e.Graphics.FillPath(fill, path); e.Graphics.DrawPath(edge, path);
                }
            }
            protected override void OnRenderToolStripBorder(ToolStripRenderEventArgs e) { }
        }
        public void Direction(bool vertical) {
            _vertical = vertical;
            _direction.ToolTipText = _direction.AccessibleName = vertical ? "切换为横排歌词" : "切换为竖排歌词";
            var oldIcon = _direction.Image; _direction.Image = DirectionIcon(!vertical); oldIcon?.Dispose();
            foreach (ToolStripItem item in Strip.Items)
                item.Margin = vertical ? new Padding(2) : new Padding(15, 2, 15, 2);
            Strip.LayoutStyle = vertical ? ToolStripLayoutStyle.VerticalStackWithOverflow : ToolStripLayoutStyle.HorizontalStackWithOverflow;
        }
        private static Bitmap DirectionIcon(bool portrait) {
            var bitmap = new Bitmap(24, 24);
            using (var g = Graphics.FromImage(bitmap)) using (var pen = new Pen(Color.Gainsboro, 1.5f)) {
                g.SmoothingMode = SmoothingMode.AntiAlias;
                var bounds = portrait ? new Rectangle(6, 2, 12, 20) : new Rectangle(2, 6, 20, 12);
                using (var path = Rounded(bounds, 2)) g.DrawPath(pen, path);
                for (int i = 0; i < 3; i++) {
                    if (portrait) g.DrawLine(pen, 10, 7 + i * 5, 14, 7 + i * 5);
                    else g.DrawLine(pen, 6 + i * 5, 10, 6 + i * 5, 14);
                }
            }
            return bitmap;
        }
        public void OffsetError() { _resetOffset.ToolTipText = "偏移未保存，请重试"; }
        public void Dispose() { if (_disposed) return; HideHint(); _disposed = true; _hintDelay.Dispose(); _hint.Dispose(); foreach (ToolStripItem item in Strip.Items) item.Image?.Dispose(); Menu.Dispose(); Strip.Dispose(); }
        private sealed class DarkColors : ProfessionalColorTable {
            public override Color ToolStripDropDownBackground { get { return Color.FromArgb(35, 37, 40); } }
            public override Color ImageMarginGradientBegin { get { return ToolStripDropDownBackground; } }
            public override Color ImageMarginGradientMiddle { get { return ToolStripDropDownBackground; } }
            public override Color ImageMarginGradientEnd { get { return ToolStripDropDownBackground; } }
            public override Color MenuItemSelected { get { return Color.FromArgb(73, 70, 65); } }
            public override Color MenuItemBorder { get { return Color.FromArgb(120, 113, 100); } }
            public override Color ButtonSelectedGradientBegin { get { return MenuItemSelected; } }
            public override Color ButtonSelectedGradientMiddle { get { return MenuItemSelected; } }
            public override Color ButtonSelectedGradientEnd { get { return MenuItemSelected; } }
        }
    }
}

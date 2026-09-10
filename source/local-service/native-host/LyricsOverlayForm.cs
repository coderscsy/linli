using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Runtime.InteropServices;
using System.Windows.Forms;
using Microsoft.Win32;

namespace OliviaSoul
{
    // Only renders two strings. Parsing, matching and timing belong to Node.
    public sealed class LyricsOverlayForm : Form
    {
        private string _current = "", _next = "";
        private int _fontSize = 28;
        private bool _locked;
        private string _family = "Microsoft YaHei UI";
        private bool _single, _animate = true;
        private bool _bold;
        private bool _vertical, _hover, _through;
        private float _textAlpha = 1;
        private float _scale = 1;
        private readonly Timer _pointer = new Timer { Interval = 120 };
        private readonly Button _unlock = new Button { Text = "", AccessibleName = "解除歌词锁定", FlatStyle = FlatStyle.Flat, BackColor = Color.FromArgb(45, 47, 50), ForeColor = Color.White, TabStop = false, Cursor = Cursors.Hand };
        private readonly ToolTip _tips = new ToolTip { ShowAlways = true };
        private double _opacity = 1;
        private Color _color = Color.FromArgb(255, 235, 170), _nextColor = Color.White;
        private readonly Timer _fade = new Timer { Interval = 30 };
        private readonly LyricsControls _actions;
        private readonly LyricsBackdropForm _backdrop = new LyricsBackdropForm();
        private ToolStrip _controls { get { return _actions.Strip; } }
        public event Action<string, object> SettingChanged;
        public event Action<int, bool> OffsetChanged;
        public event Action<int, int> PositionSaved;
        public event Action<int> FontSizeChanged;
        public event Action SettingsRequested;
        public event Action<string> PlaybackRequested;
        public LyricsOverlayForm()
        {
            FormBorderStyle = FormBorderStyle.None;
            AutoScaleMode = AutoScaleMode.None;
            Cursor = Cursors.SizeAll;
            ShowInTaskbar = false; TopMost = true; DoubleBuffered = true;
            BackColor = Color.Magenta; TransparencyKey = Color.Magenta;
            StartPosition = FormStartPosition.Manual;
            _backdrop.DragRequested = BeginDrag;
            Size = new Size(820, 116);
            SystemEvents.DisplaySettingsChanged += DisplayChanged;
            _actions = new LyricsControls(delta => FontSizeChanged?.Invoke(Math.Max(16, Math.Min(64, _fontSize + delta))),
                (delta, reset) => OffsetChanged?.Invoke(delta, reset), (key, value) => SettingChanged?.Invoke(key, value),
                () => SettingsRequested?.Invoke());
            Controls.Add(_controls); ContextMenuStrip = _actions.Menu;
            _actions.PlaybackRequested += action => PlaybackRequested?.Invoke(action);
            Controls.Add(_unlock); _unlock.Visible = false;
            _unlock.Image = LyricsControls.LockIcon(true);
            _unlock.BackColor = Color.Black; _unlock.FlatAppearance.BorderSize = 0;
            _unlock.FlatAppearance.MouseOverBackColor = Color.FromArgb(24, 24, 24); _unlock.FlatAppearance.MouseDownBackColor = Color.Black;
            _unlock.Click += (s, e) => SettingChanged?.Invoke("locked", false);
            _tips.SetToolTip(_unlock, "解除歌词锁定");
            _controls.Cursor = Cursors.Arrow;
            _controls.MouseDown += (s, e) => {
                if (e.Button == MouseButtons.Left && _controls.GetItemAt(e.Location) == null) BeginDrag();
            };
            _fade.Tick += delegate { _textAlpha = Math.Min(1, _textAlpha + 0.2f); if (_textAlpha >= 1) _fade.Stop(); Invalidate(); };
            _pointer.Tick += (s, e) => UpdatePointer();
        }
        public void Appearance(Dictionary<string, object> settings) {
            object value;
            _family = LyricsAppearance.Resolve(settings.TryGetValue("fontFamily", out value) ? Convert.ToString(value) : "auto");
            _single = settings.TryGetValue("lineMode", out value) && Convert.ToString(value) == "single";
            _vertical = settings.TryGetValue("orientation", out value) && Convert.ToString(value) == "vertical";
            _animate = !settings.TryGetValue("animate", out value) || Convert.ToBoolean(value);
            _bold = settings.TryGetValue("fontWeight", out value) && Convert.ToString(value) == "bold";
            _opacity = settings.TryGetValue("opacity", out value) ? Math.Max(0.2, Math.Min(1, Convert.ToDouble(value) / 100)) : 1;
            if (settings.TryGetValue("currentColor", out value)) _color = ColorTranslator.FromHtml(Convert.ToString(value));
            if (settings.TryGetValue("nextColor", out value)) _nextColor = ColorTranslator.FromHtml(Convert.ToString(value));
            _actions.Configure(_single, _bold, _animate, _color, _nextColor);
            _actions.Direction(_vertical);
            _fade.Stop(); _textAlpha = 1; Opacity = _opacity; Invalidate();
        }
        public void Offset(int milliseconds) { _actions.Offset(milliseconds); }
        public void OffsetError() { _actions.OffsetError(); }
        public void Playback(bool paused, bool busy, string error = null) { _actions.Playback(paused, busy, error); }
        protected override bool ShowWithoutActivation { get { return true; } }
        protected override CreateParams CreateParams
        {
            get { var p = base.CreateParams; p.ExStyle |= 0x08000000 | 0x00000080; if (_locked) p.ExStyle |= 0x20; return p; }
        }
        public void Configure(int size, bool locked, int? x, int? y)
        {
            _fontSize = size;
            _locked = locked;
            _pointer.Interval = locked ? 40 : 120;
            using (var g = CreateGraphics()) _scale = g.DpiX / 96f;
            var area = Screen.FromPoint(new Point(x ?? Screen.PrimaryScreen.WorkingArea.Left, y ?? Screen.PrimaryScreen.WorkingArea.Top)).WorkingArea;
            _controls.AutoSize = true; _controls.PerformLayout();
            var preferred = _controls.GetPreferredSize(Size.Empty);
            _controls.Size = preferred;
            int pixels = (int)Math.Round(size * _scale);
            Size = _vertical
                ? new Size(Math.Min(area.Width, preferred.Width + pixels + 48), Math.Max(200, area.Height - 100))
                : new Size(Math.Min(Math.Max(900, preferred.Width + 24), area.Width), Math.Min(area.Height, (_single ? pixels + 32 : pixels * 2 + 52) + preferred.Height));
            _controls.Location = _vertical ? new Point(8, (Height - preferred.Height) / 2) : new Point((Width - preferred.Width) / 2, 0);
            _unlock.Size = new Size(46, 46);
            _unlock.Location = _vertical
                ? new Point(_controls.Left, (Height - _unlock.Height) / 2)
                : new Point((Width - _unlock.Width) / 2, 0);
            _unlock.Visible = locked && _hover;
            Cursor = locked ? Cursors.Arrow : Cursors.SizeAll;
            Location = new Point(x ?? (_vertical ? area.Right - Width - 20 : area.Left + (area.Width - Width) / 2), y ?? (_vertical ? area.Top + (area.Height - Height) / 2 : area.Bottom - Height - 30));
            ClampToScreen(); Invalidate();
            UpdatePointer();
        }
        private void UpdatePointer() {
            if (IsDisposed) return;
            var point = PointToClient(MousePosition);
            bool hover = ClientRectangle.Contains(point) || ContextMenuStrip.Visible;
            bool changed = hover != _hover; _hover = hover;
            _controls.Visible = !_locked && hover;
            _unlock.Visible = _locked && hover;
            bool through = _locked && !_unlock.Bounds.Contains(point);
            if (IsHandleCreated && through != _through) {
                var style = GetWindowLong(Handle, -20);
                SetWindowLong(Handle, -20, through ? style | 0x20 : style & ~0x20); _through = through;
            }
            if (changed) Invalidate();
            _backdrop.Sync(this, Visible && hover && !_locked, _locked);
        }
        protected override void OnLocationChanged(EventArgs e) {
            base.OnLocationChanged(e);
            if (_backdrop != null && _backdrop.Visible) _backdrop.Sync(this, Visible && _hover && !_locked, _locked);
        }
        protected override void OnVisibleChanged(EventArgs e) {
            base.OnVisibleChanged(e);
            if (Visible) { UpdatePointer(); _pointer.Start(); } else { _pointer.Stop(); _backdrop?.Hide(); }
        }
        private void ClampToScreen()
        {
            var area = Screen.FromRectangle(Bounds).WorkingArea;
            Width = Math.Min(Width, area.Width); Height = Math.Min(Height, area.Height);
            Location = new Point(Math.Max(area.Left, Math.Min(Left, area.Right - Width)), Math.Max(area.Top, Math.Min(Top, area.Bottom - Height)));
        }
        private void DisplayChanged(object sender, EventArgs e)
        {
            if (!IsDisposed && IsHandleCreated) try { BeginInvoke((Action)ClampToScreen); } catch (InvalidOperationException) { }
        }
        public void Display(string current, string next)
        {
            if (_single && string.IsNullOrEmpty(current)) { Clear(); return; }
            if (_current != current || _next != next) { _current = current; _next = next;
                _fade.Stop(); _textAlpha = _animate && Visible ? 0.65f : 1; if (_textAlpha < 1) _fade.Start(); Invalidate(); }
            if (!Visible) Show();
        }
        public void Clear() { _fade.Stop(); _pointer.Stop(); _textAlpha = 1; _current = _next = ""; Hide(); }
        protected override void OnPaint(PaintEventArgs e)
        {
            base.OnPaint(e);
            e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
            // Keep the interior transparent; an opaque neutral edge avoids color-key fringes.
            if (_hover && !_locked)
            using (var edge = new Pen(Color.FromArgb(118, 111, 99)))
            using (var border = LyricsControls.Rounded(new Rectangle(1, 1, Width - 3, Height - 3), 9))
                e.Graphics.DrawPath(edge, border);
            int size = (int)Math.Round(_fontSize * _scale), nextSize = (int)Math.Round(Math.Max(14, _fontSize - 5) * _scale);
            if (_vertical) {
                int left = _controls.Right + 12, available = Width - left - 8;
                DrawVertical(e.Graphics, _current, new Rectangle(left, 8, available, _single ? Height - 16 : Height / 2 - 16), size, _color);
                if (!_single) DrawVertical(e.Graphics, _next, new Rectangle(left, Height / 2 + 8, available, Height / 2 - 16), nextSize, _nextColor);
            } else {
                var top = _controls.Height;
                DrawLine(e.Graphics, _current, top + 4, size, _color);
                if (!_single) DrawLine(e.Graphics, _next, top + size + 24, nextSize, _nextColor);
            }
        }
        private void DrawVertical(Graphics graphics, string text, Rectangle bounds, int size, Color color) {
            if (string.IsNullOrEmpty(text)) return;
            var elements = System.Globalization.StringInfo.GetTextElementEnumerator(text);
            var glyphs = new List<string>(); while (elements.MoveNext()) glyphs.Add(elements.GetTextElement());
            int step = size + 3, count = Math.Min(glyphs.Count, Math.Max(1, bounds.Height / step));
            int top = bounds.Top + (bounds.Height - count * step) / 2;
            for (int i = 0; i < count; i++) DrawText(graphics, i == count - 1 && count < glyphs.Count ? "…" : glyphs[i], new RectangleF(bounds.Left, top + i * step, bounds.Width, step + 6), size, color);
        }
        private void DrawLine(Graphics graphics, string text, int top, int size, Color color)
        { DrawText(graphics, text, new RectangleF(8, top, Width - 16, size + 16), size, color); }
        private void DrawText(Graphics graphics, string text, RectangleF bounds, int size, Color color)
        {
            if (string.IsNullOrEmpty(text)) return;
            using (var family = new FontFamily(_family))
            using (var font = new Font(family, size, _bold && family.IsStyleAvailable(FontStyle.Bold) ? FontStyle.Bold : FontStyle.Regular, GraphicsUnit.Pixel))
            using (var path = new GraphicsPath())
            using (var format = new StringFormat { Alignment = StringAlignment.Center, LineAlignment = StringAlignment.Center, Trimming = StringTrimming.EllipsisCharacter, FormatFlags = StringFormatFlags.NoWrap })
            using (var outline = new Pen(Color.FromArgb(35, 35, 35), 3) { LineJoin = LineJoin.Round })
            // Color-key transparency cannot blend partial alpha against the desktop:
            // fade brightness instead, keeping text opaque to avoid magenta fringes.
            using (var brush = new SolidBrush(Color.FromArgb((int)(color.R * _textAlpha), (int)(color.G * _textAlpha), (int)(color.B * _textAlpha))))
            {
                path.AddString(text, font.FontFamily, (int)font.Style, size, bounds, format);
                graphics.DrawPath(outline, path); graphics.FillPath(brush, path);
            }
        }
        protected override void OnMouseDown(MouseEventArgs e)
        {
            if (e.Button == MouseButtons.Left) BeginDrag();
            base.OnMouseDown(e);
        }
        private void BeginDrag() {
            if (_locked) return;
            ReleaseCapture(); SendMessage(Handle, 0xA1, (IntPtr)2, IntPtr.Zero);
        }
        protected override void OnMouseWheel(MouseEventArgs e)
        {
            if (!_locked) FontSizeChanged?.Invoke(Math.Max(16, Math.Min(64, _fontSize + Math.Sign(e.Delta) * 2)));
            base.OnMouseWheel(e);
        }
        protected override void WndProc(ref Message m)
        {
            if (m.Msg == 0x21) { m.Result = (IntPtr)3; return; } // MA_NOACTIVATE
            if (_locked && m.Msg == 0x84 && !_unlock.Bounds.Contains(PointToClient(MousePosition))) { m.Result = (IntPtr)(-1); return; }
            base.WndProc(ref m);
            if (m.Msg == 0x232 && !_locked) { ClampToScreen(); PositionSaved?.Invoke(Left, Top); }
        }
        protected override void Dispose(bool disposing)
        {
            if (disposing) { SystemEvents.DisplaySettingsChanged -= DisplayChanged; _fade.Dispose(); _pointer.Dispose(); _tips.Dispose(); _unlock.Image?.Dispose(); _actions.Dispose(); _backdrop.Dispose(); }
            base.Dispose(disposing);
        }
        [DllImport("user32.dll")] private static extern bool ReleaseCapture();
        [DllImport("user32.dll")] private static extern int GetWindowLong(IntPtr h, int index);
        [DllImport("user32.dll")] private static extern int SetWindowLong(IntPtr h, int index, int value);
        [DllImport("user32.dll")] private static extern IntPtr SendMessage(IntPtr h, int m, IntPtr w, IntPtr l);
    }
}

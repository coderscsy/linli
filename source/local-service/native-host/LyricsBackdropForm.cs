using System;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Windows.Forms;

namespace OliviaSoul {
    // Independent alpha keeps the lyric text and toolbar fully legible.
    internal sealed class LyricsBackdropForm : Form {
        internal Action DragRequested;
        internal bool Locked;
        internal LyricsBackdropForm() {
            FormBorderStyle = FormBorderStyle.None;
            ShowInTaskbar = false; TopMost = true;
            StartPosition = FormStartPosition.Manual;
            BackColor = Color.FromArgb(38, 35, 31);
            Opacity = 0.15; Cursor = Cursors.SizeAll;
        }
        protected override bool ShowWithoutActivation { get { return true; } }
        protected override CreateParams CreateParams {
            get { var p = base.CreateParams; p.ExStyle |= 0x08000000 | 0x80; return p; }
        }
        internal void Sync(Form foreground, bool visible, bool locked) {
            Locked = locked;
            if (!visible) { Hide(); return; }
            if (Bounds != foreground.Bounds) Bounds = foreground.Bounds;
            if (!Visible) Show();
            // Immediately below the text window, never above its controls.
            SetWindowPos(Handle, foreground.Handle, 0, 0, 0, 0, 0x0013);
        }
        protected override void OnSizeChanged(EventArgs e) {
            base.OnSizeChanged(e);
            if (Width < 4 || Height < 4) return;
            using (var path = LyricsControls.Rounded(new Rectangle(0, 0, Width, Height), 9)) {
                var old = Region; Region = new Region(path); old?.Dispose();
            }
        }
        protected override void OnMouseDown(MouseEventArgs e) {
            if (!Locked && e.Button == MouseButtons.Left) DragRequested?.Invoke();
            base.OnMouseDown(e);
        }
        protected override void WndProc(ref Message m) {
            if (m.Msg == 0x21) { m.Result = (IntPtr)3; return; }
            if (Locked && m.Msg == 0x84) { m.Result = (IntPtr)(-1); return; }
            base.WndProc(ref m);
        }
        [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int w, int height, uint flags);
    }
}

using System;
using System.Windows.Forms;

namespace OliviaSoul
{
    public sealed class StartupContext : ApplicationContext
    {
        private readonly MainForm _mainForm;
        private readonly bool _showSplash;
        private SplashForm _splash;

        public StartupContext(MainForm mainForm, bool showSplash)
        {
            _mainForm = mainForm;
            _showSplash = showSplash;
            Application.Idle += Start;
        }

        private void Start(object sender, EventArgs args)
        {
            Application.Idle -= Start;
            if (_mainForm.IsQuitting || _mainForm.IsDisposed) return;
            if (!_showSplash)
            {
                MainForm = _mainForm;
                _mainForm.Show();
                return;
            }

            _splash = new SplashForm();
            _splash.FormClosed += delegate
            {
                _splash.Dispose();
                _splash = null;
            };
            _splash.BeginAnimation(delegate
            {
                if (_mainForm.IsQuitting || _mainForm.IsDisposed) return;
                MainForm = _mainForm;
                _mainForm.Show();
            });
            _splash.Show();
        }

        protected override void Dispose(bool disposing)
        {
            Application.Idle -= Start;
            if (disposing && _splash != null) _splash.Dispose();
            base.Dispose(disposing);
        }
    }
}

using System;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Threading.Tasks;
using System.Windows.Forms;

class TrayStub { public void ShowBalloonTip(int timeout,string title,string text,ToolTipIcon icon) {} }
class TestForm : Form {
    bool _quitting, _shutdownComplete, _trayNoticeShown;
    readonly TrayStub _tray=new TrayStub();
    public int CreatedHandles;
    public TestForm(){
        FormBorderStyle=FormBorderStyle.None;StartPosition=FormStartPosition.Manual;
        Bounds=new Rectangle(-30000,-30000,800,600);MaximizedBounds=Bounds;
        Controls.Add(new Panel{Dock=DockStyle.Fill});FormClosing+=OnFormClosing;
    }
    protected override bool ShowWithoutActivation { get { return true; } }
    protected override void OnHandleCreated(EventArgs args){CreatedHandles++;base.OnHandleCreated(args);}
    Task FinishShowFromTrayAsync(){return Task.CompletedTask;}
    /* HANDLERS */
}
static class Harness {
    [DllImport("user32.dll")]static extern bool IsWindowVisible(IntPtr handle);
    [STAThread] static int Main(){
        try {
            Application.EnableVisualStyles();
            foreach(var state in new[]{FormWindowState.Normal,FormWindowState.Maximized,FormWindowState.Minimized}){
                using(var form=new TestForm()){
                    form.Show();form.WindowState=state;Application.DoEvents();
                    for(int count=0;count<3;count++){
                        form.Close();Application.DoEvents();
                        Console.WriteLine("state="+state+" visible="+form.Visible+" nativeVisible="+IsWindowVisible(form.Handle)+" taskbar="+form.ShowInTaskbar+" handles="+form.CreatedHandles);
                        if(form.Visible||IsWindowVisible(form.Handle)||form.ShowInTaskbar||form.IsDisposed)throw new Exception("One Close did not hide the complete window: "+state);
                        form.ShowFromTray();Application.DoEvents();
                        if(!form.Visible||!IsWindowVisible(form.Handle)||!form.ShowInTaskbar)throw new Exception("Tray reopen failed");
                        if(state==FormWindowState.Maximized&&form.WindowState!=state)throw new Exception("Maximized state was lost");
                    }
                }
            }
            return 0;
        } catch(Exception error){Console.Error.WriteLine(error);return 1;}
    }
}

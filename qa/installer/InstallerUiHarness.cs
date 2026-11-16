#if INSTALLER_QA
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Text;
using System.Threading;
using System.Windows.Forms;
namespace SusuClash.Installer
{
    // Opt-in executable entry for isolated native rendering. It is inert in the
    // embedded-UI DLL and cannot call DTF: the reducer/view are its only inputs.
    public static class InstallerUiHarness
    {
        private static bool simulated150;
        [STAThread]
        public static int Main(string[] args) { return Run(args); }
        public static int Run(string[] args)
        {
            if (args.Length != 2 || (args[0] != "--installer-ui-qa" && args[0] != "--installer-ui-delta" && args[0] != "--installer-ui-qa-150")) return 2;
            simulated150=args[0]=="--installer-ui-qa-150";
            string output = Path.GetFullPath(args[1]); Directory.CreateDirectory(output); List<string> checks = new List<string>();
            InstallerNative.PrepareThread(); Application.EnableVisualStyles(); Application.SetCompatibleTextRenderingDefault(false);
            try {
                if(args[0]=="--installer-ui-delta"){RunDelta(output,checks);File.WriteAllText(Path.Combine(output,"native-ui-delta-qa.json"),"{\"passed\":true,\"isolated\":true,\"installerCalls\":0,\"samples\":["+String.Join(",",checks.ToArray())+"]}",new UTF8Encoding(false));return 0;}
                foreach (InstallerThemeData theme in InstallerTheme.All) {
                    using (InstallerForm form = NewForm(theme.Key)) {
                        Capture(form, output, theme.Key + "-welcome.png"); checks.Add(form.HarnessMetrics());
                        form.HarnessConsent(); if (form.HarnessPrimary == null || !form.HarnessPrimary.Enabled) throw new InvalidOperationException("Consent must enable start");
                        form.StartRequested += delegate { form.BeginInstall(); }; form.HarnessPrimary.PerformClick();
                        form.UpdateProgress(new ProgressSnapshot(48,"正在安装 SusuClash","正在复制应用文件",true,false,false,false)); Pump(100); Capture(form,output,theme.Key+"-installing.png"); checks.Add(form.HarnessMetrics());
                        string moving1=CaptureOrbit(form,output,theme.Key+"-gif-frame1.png"),moving2=moving1;for(int frame=0;frame<4&&moving1==moving2;frame++){Pump(317+frame*151);moving2=CaptureOrbit(form,output,theme.Key+"-gif-frame2.png");}if(moving1==moving2)throw new InvalidOperationException("Actual GIF frames must differ");
                        ThemeButton cancelControl=form.HarnessCancel;cancelControl.Focus();System.Diagnostics.Stopwatch flood=System.Diagnostics.Stopwatch.StartNew();
                        for(int message=0;message<1000;message++)form.UpdateProgress(new ProgressSnapshot(message%99,"正在安装 SusuClash",message%2==0?"正在复制应用文件":"正在创建应用快捷方式",true,false,false,false));
                        flood.Stop();if(!Object.ReferenceEquals(cancelControl,form.HarnessCancel)||!cancelControl.Focused)throw new InvalidOperationException("1000 real view updates must preserve cancel control and focus");
                        checks.Add("{\"theme\":\""+theme.Key+"\",\"progressMessages\":1000,\"sameControl\":true,\"focusRetained\":true,\"elapsedMs\":"+flood.ElapsedMilliseconds+"}");
                        form.UpdateProgress(new ProgressSnapshot(100,"等待安装引擎确认","实际ticks不能自行显示成功",true,false,false,false)); if (!form.HarnessMetrics().Contains("\"percent\":99")) throw new InvalidOperationException("Ticks cannot confirm 100%");
                        form.UpdateProgress(new ProgressSnapshot(48,"正在安装 SusuClash","正在复制应用文件",true,false,false,false));
                        form.HarnessReducedMotion(true); if (form.HarnessOrbit.Running) throw new InvalidOperationException("Reduced motion must stop GIF"); Capture(form, output, theme.Key + "-reduced.png"); form.HarnessReducedMotion(false);
                        form.Complete(InstallerOutcome.Success); if (form.HarnessOrbit.Running) throw new InvalidOperationException("Success uses poster"); Capture(form,output,theme.Key+"-success.png"); checks.Add(form.HarnessMetrics());
                        string still1=CaptureOrbit(form,output,theme.Key+"-poster-frame1.png");Pump(450);string still2=CaptureOrbit(form,output,theme.Key+"-poster-frame2.png");if(still1!=still2)throw new InvalidOperationException("Completed poster must stay unchanged");checks.Add("{\"theme\":\""+theme.Key+"\",\"gifFramesDiffer\":true,\"successFramesSame\":true}");
                        form.HarnessSize(640,540);if(!form.HarnessCheckShortScroll())throw new InvalidOperationException("Short viewport must scroll to checkbox without moving footer");Capture(form,output,theme.Key+"-success-short.png");
                        form.CloseFromEngine();
                    }
                    foreach (InstallerOutcome outcome in new InstallerOutcome[]{InstallerOutcome.Cancelled,InstallerOutcome.Failure,InstallerOutcome.RestartRequired,InstallerOutcome.Unknown}) using(InstallerForm form=NewForm(theme.Key)) { form.BeginInstall();form.UpdateProgress(new ProgressSnapshot(48,"正在安装 SusuClash","正在复制应用文件",true,false,false,false));form.Complete(outcome);Capture(form,output,theme.Key+"-"+outcome.ToString().ToLowerInvariant()+".png");checks.Add(form.HarnessMetrics());form.CloseFromEngine(); }
                    using(InstallerForm form=NewForm(theme.Key)) {
                        form.BeginInstall(); int cancellations=0; form.CancelRequested+=delegate { cancellations++; };
                        Exception cancelError=null;System.Windows.Forms.Timer confirm = new System.Windows.Forms.Timer(); confirm.Interval=200; confirm.Tick+=delegate { InstallerSheet sheet=FindSheet();if(sheet!=null){confirm.Stop();try{CheckTabCycle(sheet);Capture(sheet,output,theme.Key+"-cancel-dialog.png");sheet.DismissControl.PerformClick();}catch(Exception error){cancelError=error;sheet.DialogResult=DialogResult.Cancel;sheet.Close();}} };confirm.Start();form.HarnessCancel.PerformClick();confirm.Dispose();if(cancelError!=null)throw cancelError;
                        if(cancellations!=1||!form.HarnessBusy)throw new InvalidOperationException("Cancel must request once and await engine");Capture(form,output,theme.Key+"-cancelling.png");checks.Add(form.HarnessMetrics());
                        form.UpdateProgress(new ProgressSnapshot(32,"正在回滚安装","Windows Installer 正在撤回本次变更",false,true,true,false));Capture(form,output,theme.Key+"-rollback.png");form.Complete(InstallerOutcome.Cancelled);form.CloseFromEngine();
                    }
                    using(InstallerForm form=NewForm(theme.Key)) {
                        Exception licenseError=null;System.Windows.Forms.Timer licenseTimer = new System.Windows.Forms.Timer();licenseTimer.Interval=200;licenseTimer.Tick+=delegate { InstallerSheet sheet=FindSheet();if(sheet!=null){licenseTimer.Stop();try{if(sheet.LicenseControl==null||sheet.LicenseControl.TextLength<30000)throw new InvalidOperationException("Full license required");CheckTabCycle(sheet);sheet.LicenseControl.SelectionStart=sheet.LicenseControl.TextLength-1;sheet.LicenseControl.ScrollToCaret();Pump(50);sheet.LicenseControl.SelectionStart=0;sheet.LicenseControl.ScrollToCaret();Capture(sheet,output,theme.Key+"-license.png");sheet.HarnessKey(Keys.Escape);}catch(Exception error){licenseError=error;sheet.DialogResult=DialogResult.Cancel;sheet.Close();}} };licenseTimer.Start();form.HarnessLicense();licenseTimer.Dispose();if(licenseError!=null)throw licenseError;Control[] link=form.Controls.Find("license",true);if(link.Length!=1||!link[0].Focused)throw new InvalidOperationException("Escape must return license focus");form.CloseFromEngine();
                    }
                }
                File.WriteAllText(Path.Combine(output,"native-ui-qa.json"),"{\"passed\":true,\"isolated\":true,\"installerCalls\":0,\"simulatedScale\":"+(simulated150?"1.5":"1")+",\"systemDpiChanged\":false,\"scope\":\""+(simulated150?"Simulated 150% layout through private view scale; not a real OS DPI test":"Native current-system DPI layout")+"\",\"identity\":"+Identity()+",\"samples\":["+String.Join(",",checks.ToArray())+"]}",new UTF8Encoding(false));return 0;
            } catch(Exception error) {File.WriteAllText(Path.Combine(output,"native-ui-qa-error.txt"),error.ToString(),new UTF8Encoding(false));return 1;}
            finally { InstallerPaint.ClearCache(); }
        }
        private static InstallerForm NewForm(string theme) { InstallerForm form=new InstallerForm();form.CloseRequested+=form.CloseFromEngine;form.FinishRequested+=form.CloseFromEngine;form.Show();form.HarnessTheme(theme);if(simulated150){typeof(InstallerForm).GetField("scale",System.Reflection.BindingFlags.Instance|System.Reflection.BindingFlags.NonPublic).SetValue(form,1.5f);form.HarnessSize(760,569);}Pump(80);if(form.ClientSize.Width!=(simulated150?1140:760)||form.ClientSize.Height!=(simulated150?854:569))throw new InvalidOperationException("Default native/simulated viewport mismatch");return form; }
        private static string HashFile(string file){using(System.Security.Cryptography.SHA256 hash=System.Security.Cryptography.SHA256.Create())return BitConverter.ToString(hash.ComputeHash(File.ReadAllBytes(file))).Replace("-","").ToLowerInvariant();}
        private static string Identity(){return "{\"formSourceSha256\":\""+HashFile("packaging/installer/InstallerForm.cs")+"\",\"harnessSourceSha256\":\""+HashFile("qa/installer/InstallerUiHarness.cs")+"\",\"exeSha256\":\""+HashFile(System.Reflection.Assembly.GetExecutingAssembly().Location)+"\"}";}
        private static void RunDelta(string output,List<string> checks)
        {
            foreach(InstallerThemeData theme in InstallerTheme.All){
                using(InstallerForm form=NewForm(theme.Key)){
                    form.HarnessConsent();Control help=form.Controls.Find("consent-help",true)[0];if(help.Text!="准备好了，可以开始安装。")throw new InvalidOperationException("Consent copy must reflect acceptance");
                    ((CheckBox)form.Controls.Find("consent",true)[0]).Checked=false;if(help.Text!="请先阅读并接受许可协议。")throw new InvalidOperationException("Revoked consent copy");
                    form.HarnessSize(360,340);CaptureScreen(form,output,theme.Key+"-welcome-narrow.png");
                    InspectSheet(form.HarnessLicense,delegate(InstallerSheet sheet){CheckSheetBounds(sheet);CheckTabCycle(sheet);CaptureScreen(sheet,output,theme.Key+"-license-narrow.png");sheet.HarnessKey(Keys.Escape);});
                    if(!form.Controls.Find("license",true)[0].Focused)throw new InvalidOperationException("Narrow Escape focus return");
                    InspectSheet(form.HarnessLicense,delegate(InstallerSheet sheet){sheet.ConfirmControl.PerformClick();});
                    if(!((CheckBox)form.Controls.Find("consent",true)[0]).Checked||form.Controls.Find("consent-help",true)[0].Text!="准备好了，可以开始安装。")throw new InvalidOperationException("License acceptance must update consent copy");
                    form.BeginInstall();form.UpdateProgress(new ProgressSnapshot(48,"正在安装 SusuClash","正在复制应用文件",true,false,false,false));int cancel=0;form.CancelRequested+=delegate{cancel++;};
                    InspectSheet(delegate{form.HarnessCancel.PerformClick();},delegate(InstallerSheet sheet){CheckSheetBounds(sheet);CheckTabCycle(sheet);CaptureScreen(sheet,output,theme.Key+"-cancel-narrow.png");sheet.HarnessKey(Keys.Escape);});
                    if(cancel!=0||!form.HarnessBusy)throw new InvalidOperationException("Escape must continue installation");form.CloseFromEngine();
                }
                foreach(InstallerOutcome final in new InstallerOutcome[]{InstallerOutcome.Failure,InstallerOutcome.Unknown,InstallerOutcome.Success})using(InstallerForm form=NewForm(theme.Key)){
                    form.BeginInstall();form.UpdateProgress(new ProgressSnapshot(48,"正在安装 SusuClash","正在复制应用文件",true,false,false,false));form.Complete(final);
                    if(final!=InstallerOutcome.Success){Control copy=form.Controls.Find("result-help",true)[0];if(copy.Text.Contains("请先等待"))throw new InvalidOperationException("Terminal copy cannot request waiting");if(final==InstallerOutcome.Unknown&&!form.Controls.Find("orbit-caption",true)[0].Text.Contains("结果待确认"))throw new InvalidOperationException("Unknown must not claim failure");}
                    CaptureScreen(form,output,theme.Key+"-"+final.ToString().ToLowerInvariant()+"-screen.png");form.CloseFromEngine();
                }
                using(InstallerForm form=NewForm(theme.Key)){form.BeginInstall();form.Complete(InstallerOutcome.Success);form.Close();if(form.FinishApproved)throw new InvalidOperationException("X must not approve launch");}
                using(InstallerForm form=NewForm(theme.Key)){form.BeginInstall();form.Complete(InstallerOutcome.Success);form.HarnessPrimary.PerformClick();if(!form.FinishApproved)throw new InvalidOperationException("Finish must explicitly approve launch");}
                checks.Add("{\"theme\":\""+theme.Key+"\",\"narrow\":\"360x340\",\"consentCopy\":true,\"licenseAcceptCopy\":true,\"terminalCopy\":true,\"sheetBounds\":true,\"tabBothWays\":true,\"escapeFocus\":true,\"finishVersusX\":true}");
            }
        }
        private static void InspectSheet(Action open,Action<InstallerSheet> inspect){Exception failure=null;System.Windows.Forms.Timer timer=new System.Windows.Forms.Timer();timer.Interval=150;timer.Tick+=delegate{InstallerSheet sheet=FindSheet();if(sheet==null)return;timer.Stop();try{inspect(sheet);}catch(Exception error){failure=error;sheet.DialogResult=DialogResult.Cancel;sheet.Close();}};timer.Start();open();timer.Dispose();if(failure!=null)throw failure;}
        private static void CheckSheetBounds(InstallerSheet sheet){Control copy=sheet.Controls.Find("sheet-copy",true)[0];if(copy.Bottom>sheet.DismissControl.Top-4)throw new InvalidOperationException("Sheet copy overlaps footer");foreach(Control button in new Control[]{sheet.DismissControl,sheet.ConfirmControl})if(button.Left<0||button.Top<0||button.Right>sheet.ClientSize.Width||button.Bottom>sheet.ClientSize.Height)throw new InvalidOperationException("Sheet button outside viewport");}
        private static InstallerSheet FindSheet() { foreach(Form form in Application.OpenForms)if(form is InstallerSheet)return (InstallerSheet)form;return null; }
        private static void Pump(int milliseconds) { int until=Environment.TickCount+milliseconds;do{Application.DoEvents();Thread.Sleep(10);}while(unchecked(Environment.TickCount-until)<0); }
        private static void CheckTabCycle(InstallerSheet sheet){for(int i=0;i<8;i++){sheet.HarnessKey(Keys.Tab);if(!sheet.ContainsFocus)throw new InvalidOperationException("Tab focus escaped sheet");}for(int i=0;i<8;i++){sheet.HarnessKey(Keys.Tab|Keys.Shift);if(!sheet.ContainsFocus)throw new InvalidOperationException("Shift+Tab focus escaped sheet");}}
        private static string CaptureOrbit(InstallerForm form,string directory,string name){Pump(20);using(Bitmap bitmap=new Bitmap(form.HarnessOrbit.Width,form.HarnessOrbit.Height)){form.HarnessOrbit.DrawToBitmap(bitmap,new Rectangle(Point.Empty,bitmap.Size));using(MemoryStream stream=new MemoryStream()){bitmap.Save(stream,ImageFormat.Png);byte[] bytes=stream.ToArray();File.WriteAllBytes(Path.Combine(directory,name),bytes);using(System.Security.Cryptography.SHA256 hash=System.Security.Cryptography.SHA256.Create())return Convert.ToBase64String(hash.ComputeHash(bytes));}}}
        private static void Capture(Form form,string directory,string name) { Pump(60); using(Bitmap bitmap=new Bitmap(form.ClientSize.Width,form.ClientSize.Height)){if(form is InstallerSheet){form.BringToFront();form.Activate();Pump(100);using(Graphics graphics=Graphics.FromImage(bitmap))graphics.CopyFromScreen(form.PointToScreen(Point.Empty),Point.Empty,bitmap.Size);}else form.DrawToBitmap(bitmap,form.ClientRectangle);bitmap.Save(Path.Combine(directory,name),ImageFormat.Png);} }
        private static void CaptureScreen(Form form,string directory,string name){form.BringToFront();form.Activate();Pump(100);using(Bitmap bitmap=new Bitmap(form.ClientSize.Width,form.ClientSize.Height)){using(Graphics graphics=Graphics.FromImage(bitmap))graphics.CopyFromScreen(form.PointToScreen(Point.Empty),Point.Empty,bitmap.Size);bitmap.Save(Path.Combine(directory,name),ImageFormat.Png);}}
    }
}
#endif

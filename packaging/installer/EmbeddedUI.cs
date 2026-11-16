using System;
using System.Diagnostics;
using System.IO;
using System.Threading;
using System.Windows.Forms;
using WixToolset.Dtf.WindowsInstaller;

namespace SusuClash.Installer
{
    // DTF locates this public, parameterless IEmbeddedUI implementation when MakeSfxCA
    // creates the native-exporting package. It is loaded from MsiEmbeddedUI, not an EXE wrapper.
    public sealed class EmbeddedUI : IEmbeddedUI
    {
        private readonly ManualResetEvent start = new ManualResetEvent(false);
        private readonly ManualResetEvent exited = new ManualResetEvent(false);
        private Thread uiThread;
        private InstallerForm form;
        private EngineProgress progress;
        private ProgressSnapshot lastShownProgress;
        private volatile bool started, shuttingDown, initializationFailed;
        private bool desktopShortcut = true, launchAfterInstall, launchApproved, finishApproved;
        private string expectedDirectory;
        private int shutdownOnce;

        public EmbeddedUI() { }

        public bool Initialize(Session session, string resourcePath, ref InstallUIOptions internalUILevel)
        {
            if (session == null) throw new ArgumentNullException("session");
            // The MSI handle is valid ONLY in this method. Never retain it or capture it in UI events.
            if (!InstallerPolicy.ShouldHandleUI((int)internalUILevel,
                session["Installed"], session["REMOVE"], session["REINSTALL"])) return false;

            string productCode = session["ProductCode"];
            if (String.IsNullOrEmpty(productCode)) throw new InstallerException("Installer product identity is unavailable.");
            progress = new EngineProgress(productCode);
            expectedDirectory = Path.GetFullPath(Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs\\ClashGlass"));
            uiThread = new Thread(RunView);
            uiThread.Name = "SusuClash MSI interface";
            uiThread.SetApartmentState(ApartmentState.STA);
            uiThread.Start();

            // Only a real user Start releases MSI execution. Closing Welcome cancels before writes.
            int selected = WaitHandle.WaitAny(new WaitHandle[] { start, exited });
            if (initializationFailed)
            {
                if (uiThread != null) uiThread.Join();
                // Preserve the authored MSI UI as a fail-safe if the custom interface cannot open.
                return false;
            }
            if (selected != 0 || !started)
            {
                if (uiThread != null) uiThread.Join();
                throw new InstallCanceledException();
            }

            try
            {
                // This version keeps the existing per-user install location. A command-line
                // directory is never used later as an arbitrary launcher path.
                session["INSTALLFOLDER"] = expectedDirectory + Path.DirectorySeparatorChar;
                session["INSTALLDESKTOPSHORTCUT"] = desktopShortcut ? "1" : "0";
                string resolvedDirectory = session["INSTALLFOLDER"];
                launchApproved = SameDirectory(resolvedDirectory, expectedDirectory);
                internalUILevel = InstallUIOptions.Silent | InstallUIOptions.SourceResolutionOnly;
                return true;
            }
            catch
            {
                shuttingDown = true;
                CloseView();
                uiThread.Join();
                throw;
            }
        }

        private void RunView()
        {
            try
            {
                // Do not call Application.SetCompatibleTextRenderingDefault: msiexec may already
                // have initialized WinForms in this process. The view owns only this STA loop.
                form = new InstallerForm();
                form.StartRequested += delegate
                {
                    if (started || shuttingDown) return;
                    desktopShortcut = form.CreateDesktopShortcut;
                    started = true;
                    form.BeginInstall();
                    form.UpdateProgress(progress.Snapshot);
                    start.Set();
                };
                form.CancelRequested += delegate
                {
                    if (!started) CloseView();
                    else if (!shuttingDown) { progress.RequestCancel(); form.UpdateProgress(progress.Snapshot); }
                };
                form.CloseRequested += delegate
                {
                    if (!started || shuttingDown) CloseView();
                    else { progress.RequestCancel(); form.UpdateProgress(progress.Snapshot); }
                };
                form.FinishRequested += delegate
                {
                    // A window close, a crashed UI, and the Start click never authorize launch.
                    if (!shuttingDown) return;
                    finishApproved = progress.Outcome == InstallerOutcome.Success;
                    launchAfterInstall = form.LaunchAfterInstall;
                    CloseView();
                };
                Application.Run(form);
            }
            catch
            {
                // No raw record/exception/path is logged or sent to the product interface.
                if (!started) initializationFailed = true;
                else if (progress != null) progress.RequestCancel();
            }
            finally
            {
                if (started && !shuttingDown && progress != null) progress.RequestCancel();
                exited.Set();
            }
        }

        public MessageResult ProcessMessage(InstallMessage messageType, Record messageRecord,
            MessageButtons buttons, MessageIcon icon, MessageDefaultButton defaultButton)
        {
            if (progress == null) return MessageResult.None;
            try
            {
                // Copy values while the callback's MSI-owned Record is valid. Never enqueue Record.
                switch (messageType)
                {
                    case InstallMessage.Progress:
                        int kind, field2, field3, field4;
                        if (Integer(messageRecord, 1, out kind) && Integer(messageRecord, 2, out field2))
                        {
                            field3 = 0; field4 = 0;
                            if ((kind == 0 || kind == 1) && !Integer(messageRecord, 3, out field3)) break;
                            if (kind == 0 && !Integer(messageRecord, 4, out field4)) break;
                            progress.AcceptProgress(kind, field2, field3, field4);
                        }
                        break;
                    case InstallMessage.ActionData: progress.AcceptActionData(); break;
                    case InstallMessage.ActionStart:
                        progress.AcceptAction(Text(messageRecord, 1), Text(messageRecord, 2)); break;
                    case InstallMessage.CommonData:
                        int commonKind, cancelAllowed;
                        if (Integer(messageRecord, 1, out commonKind) && commonKind == 2 &&
                            Integer(messageRecord, 2, out cancelAllowed)) progress.SetCancellationAllowed(cancelAllowed != 0);
                        break;
                    case InstallMessage.InstallEnd:
                        int result;
                        if (Integer(messageRecord, 3, out result)) progress.AcceptInstallEnd(Text(messageRecord, 2), result);
                        break;
                    case InstallMessage.Info:
                        int reboot;
                        if (messageRecord != null && messageRecord.FieldCount == 3 &&
                            Text(messageRecord, 1) == InstallerPolicy.RebootStateMarker &&
                            Integer(messageRecord, 3, out reboot) && (reboot == 0 || reboot == 1))
                            progress.AcceptRebootState(Text(messageRecord, 2), reboot == 1);
                        break;
                    case InstallMessage.ResolveSource:
                        // SourceResolutionOnly keeps the installer's own source-location dialog available.
                        return MessageResult.None;
                    case InstallMessage.FilesInUse:
                        return PromptFilesInUse(messageRecord);
                    case InstallMessage.RMFilesInUse:
                        // IDRETRY explicitly requests the traditional FilesInUse message. Never
                        // return IDOK, which would authorize Restart Manager to close other apps.
                        // https://learn.microsoft.com/windows/win32/msi/using-restart-manager-with-an-external-ui-
                        return MessageResult.Retry;
                    case InstallMessage.Error:
                    case InstallMessage.Warning:
                    case InstallMessage.User:
                    case InstallMessage.OutOfDiskSpace:
                        return Prompt(messageRecord, buttons, icon, defaultButton);
                    case InstallMessage.FatalExit:
                        // FatalExit alone lacks the final installation return code. Shutdown will
                        // honestly display Unknown unless InstallEnd supplies this product's result.
                        break;
                }
                PushProgress();
                if ((messageType == InstallMessage.Progress || messageType == InstallMessage.ActionData) &&
                    progress.ShouldReturnCancel) return MessageResult.Cancel;
                return MessageResult.OK;
            }
            catch
            {
                // A failing UI callback must never report successful installation or skip engine cleanup.
                progress.RequestCancel();
                return MessageResult.Error;
            }
        }

        private MessageResult Prompt(Record record, MessageButtons buttons, MessageIcon icon, MessageDefaultButton defaultButton)
        {
            string text = record == null ? "Windows Installer 需要处理安装问题。" : record.ToString();
            if (String.IsNullOrEmpty(text)) text = "Windows Installer 需要处理安装问题。请查看安装日志。";
            if (text.Length > 8192) text = text.Substring(0, 8192);
            return PromptText(text, buttons, icon, defaultButton);
        }

        private MessageResult PromptFilesInUse(Record record)
        {
            string list = record == null ? "" : record.ToString();
            if (list.Length > 8192) list = list.Substring(0, 8192);
            return PromptText("部分应用仍在使用需要更新的文件。请先保存工作并手动关闭相关应用，然后选择重试；也可以取消本次安装。\r\n\r\n" + list,
                MessageButtons.RetryCancel, MessageIcon.Warning, MessageDefaultButton.Button1);
        }

        private MessageResult PromptText(string text, MessageButtons buttons, MessageIcon icon, MessageDefaultButton defaultButton)
        {
            MessageResult result = MessageResult.None;
            InstallerForm target = form;
            if (target == null || target.IsDisposed || !target.IsHandleCreated) return result;
            target.Invoke((Action)delegate
            {
                MessageBoxButtons shownButtons = (MessageBoxButtons)(int)buttons;
                if (!Enum.IsDefined(typeof(MessageBoxButtons), shownButtons)) return;
                MessageBoxDefaultButton shownDefault = (MessageBoxDefaultButton)(int)defaultButton;
                if (!Enum.IsDefined(typeof(MessageBoxDefaultButton), shownDefault)) shownDefault = MessageBoxDefaultButton.Button1;
                result = (MessageResult)(int)MessageBox.Show(target, text, "SusuClash 安装程序", shownButtons,
                    (MessageBoxIcon)(int)icon, shownDefault);
            });
            return result;
        }

        public void Shutdown()
        {
            if (progress == null || uiThread == null) return;
            if (Interlocked.Exchange(ref shutdownOnce, 1) != 0) return;
            progress.Shutdown();
            shuttingDown = true;
            InstallerForm target = form;
            if (target != null && !target.IsDisposed && target.IsHandleCreated)
            {
                try { target.Invoke((Action)delegate { target.UpdateProgress(progress.Snapshot); target.Complete(progress.Outcome); }); }
                catch { CloseView(); }
            }
            // Windows Installer has ended. Keep the result visible until the user closes it;
            // the UI thread cannot call Session, rerun installation or infer success here.
            uiThread.Join();
            if (InstallerPolicy.ShouldLaunch(progress.Outcome, finishApproved, launchAfterInstall, launchApproved))
                LaunchInstalledApplication();
            start.Dispose(); exited.Dispose();
        }

        private void PushProgress()
        {
            InstallerForm target = form;
            if (target == null || target.IsDisposed || !target.IsHandleCreated) return;
            ProgressSnapshot next = progress.Snapshot, prior = lastShownProgress;
            if (prior != null && prior.Percent == next.Percent && prior.Phase == next.Phase && prior.Detail == next.Detail &&
                prior.CanCancel == next.CanCancel && prior.CancellationRequested == next.CancellationRequested &&
                prior.IsRollback == next.IsRollback && prior.IsFinal == next.IsFinal) return;
            // Suppress identical visual states, without clocks, estimated increments or dropped phase changes.
            lastShownProgress = next;
            target.UpdateProgress(next);
        }

        private void CloseView()
        {
            InstallerForm target = form;
            if (target == null || target.IsDisposed || !target.IsHandleCreated) return;
            try
            {
                if (target.InvokeRequired) target.BeginInvoke((Action)delegate { target.CloseFromEngine(); });
                else target.CloseFromEngine();
            }
            catch (InvalidOperationException) { /* The STA already closed while dispatching cleanup. */ }
        }

        private static bool Integer(Record record, int field, out int value)
        {
            value = 0;
            if (record == null || field > record.FieldCount || record.IsNull(field)) return false;
            value = record.GetInteger(field); return true;
        }

        private static string Text(Record record, int field)
        {
            return record != null && field <= record.FieldCount && !record.IsNull(field) ? record.GetString(field) : "";
        }

        private static bool SameDirectory(string left, string right)
        {
            try { return String.Equals(Path.GetFullPath(left).TrimEnd('\\', '/'), Path.GetFullPath(right).TrimEnd('\\', '/'), StringComparison.OrdinalIgnoreCase); }
            catch { return false; }
        }

        private void LaunchInstalledApplication()
        {
            bool opened = false;
            try
            {
                string expected = Path.GetFullPath(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs\\ClashGlass"));
                if (SameDirectory(expectedDirectory, expected))
                {
                    string launcher = Path.Combine(expected, "Start-Clash-Glass.cmd");
                    if (File.Exists(launcher))
                    {
                        ProcessStartInfo info = new ProcessStartInfo(launcher);
                        info.WorkingDirectory = expected; info.UseShellExecute = true; info.WindowStyle = ProcessWindowStyle.Hidden;
                        using (Process launched = Process.Start(info)) { opened = launched != null; }
                    }
                }
            }
            catch { /* The completed installation remains complete if an optional launch is denied. */ }
            if (!opened)
            {
                try { MessageBox.Show("安装已完成，但未能打开 SusuClash。请使用桌面或开始菜单中的快捷方式打开应用。", "SusuClash 安装程序", MessageBoxButtons.OK, MessageBoxIcon.Information); }
                catch { /* An optional notification cannot change Windows Installer's final result. */ }
            }
        }
    }
}

using System;

namespace SusuClash.Installer
{
    public enum InstallerOutcome { Unknown, Success, RestartRequired, Cancelled, Failure }

    public sealed class ProgressSnapshot
    {
        public int? Percent { get; private set; }
        public string Phase { get; private set; }
        public string Detail { get; private set; }
        public bool CanCancel { get; private set; }
        public bool CancellationRequested { get; private set; }
        public bool IsRollback { get; private set; }
        public bool IsFinal { get; private set; }

        public ProgressSnapshot(int? percent, string phase, string detail, bool canCancel,
            bool cancellationRequested, bool isRollback, bool isFinal)
        {
            Percent = percent; Phase = phase ?? ""; Detail = detail ?? "";
            CanCancel = canCancel; CancellationRequested = cancellationRequested;
            IsRollback = isRollback; IsFinal = isFinal;
        }
    }

    public interface IInstallerView
    {
        event Action StartRequested;
        event Action CancelRequested;
        event Action CloseRequested;
        event Action FinishRequested;
        bool CreateDesktopShortcut { get; }
        bool LaunchAfterInstall { get; }
        void BeginInstall();
        void UpdateProgress(ProgressSnapshot snapshot);
        void Complete(InstallerOutcome outcome);
    }

    public static class InstallerPolicy
    {
        public const string RebootStateMarker = "SusuClash.Installer.RebootState.v1";
        // Keep quiet/basic/reduced and every maintenance route on the authored MSI UI.
        // No property is changed when this method declines the custom UI.
        public static bool ShouldHandleUI(int uiLevel, string installed, string remove, string reinstall)
        {
            return (uiLevel & 7) == 5 && String.IsNullOrEmpty(installed) &&
                String.IsNullOrEmpty(remove) && String.IsNullOrEmpty(reinstall);
        }

        public static bool ShouldLaunch(InstallerOutcome outcome, bool finishApproved, bool launchChecked, bool sameInstallDirectory)
        {
            return outcome == InstallerOutcome.Success && finishApproved && launchChecked && sameInstallDirectory;
        }
    }

    // Pure MSI message reducer. There is deliberately no clock, timer or simulated work.
    // Field meanings: https://learn.microsoft.com/windows/win32/msi/parsing-windows-installer-messages
    public sealed class EngineProgress
    {
        private readonly object gate = new object();
        private readonly string productCode;
        private long total, position, actionTicks;
        private bool hasReset, backwards, actionDataEnabled, canCancel = true;
        private bool cancelRequested, final, sawEnd;
        private string phase = "正在准备安装", detail = "等待 Windows Installer 提供进度";
        private InstallerOutcome outcome = InstallerOutcome.Unknown;
        private int? engineStatus;
        private bool? restartRequired;
        private bool rebootStateConflict;

        public EngineProgress(string productCode)
        {
            if (String.IsNullOrEmpty(productCode)) throw new ArgumentException("ProductCode is required.", "productCode");
            this.productCode = productCode;
        }

        public InstallerOutcome Outcome { get { lock (gate) return outcome; } }
        public int? EngineStatus { get { lock (gate) return engineStatus; } }
        // Compatibility alias for QA callers. This is the INSTALLEND action status, never a Win32 exit code.
        public int? ReturnCode { get { return EngineStatus; } }
        public bool? RestartRequired { get { lock (gate) return rebootStateConflict ? null : restartRequired; } }
        public bool ShouldReturnCancel { get { lock (gate) return cancelRequested && canCancel && !backwards && !final; } }
        public ProgressSnapshot Snapshot
        {
            get
            {
                lock (gate)
                {
                    int? percent = null;
                    if (hasReset && total > 0)
                        percent = (int)Math.Max(0, Math.Min(99, (double)position * 100.0 / total));
                    if (final && (outcome == InstallerOutcome.Success || outcome == InstallerOutcome.RestartRequired)) percent = 100;
                    string shownPhase = cancelRequested && !final && !backwards ? "正在取消安装" : phase;
                    string shownDetail = cancelRequested && !final && !backwards ? "等待 Windows Installer 停止并完成必要回滚" : detail;
                    return new ProgressSnapshot(percent, shownPhase, shownDetail,
                        canCancel && !cancelRequested && !backwards && !final, cancelRequested, backwards, final);
                }
            }
        }

        public void AcceptProgress(int kind, int field2, int field3, int field4)
        {
            lock (gate)
            {
                if (final) return;
                switch (kind)
                {
                    case 0: // reset: total, direction, execution/script-generation
                        if (field2 < 0 || (field3 != 0 && field3 != 1) || (field4 != 0 && field4 != 1)) return;
                        total = field2; backwards = field3 == 1; position = backwards ? total : 0;
                        hasReset = true; actionDataEnabled = false; actionTicks = 0;
                        phase = backwards ? "正在回滚安装" : (field4 == 1 ? "正在准备安装" : "正在安装 SusuClash");
                        detail = backwards ? "Windows Installer 正在撤回本次变更" : "进度由 Windows Installer 实际工作量提供";
                        break;
                    case 1: // ActionData ticks, enabled flag
                        if (!hasReset || field2 < 0 || (field3 != 0 && field3 != 1)) return;
                        actionTicks = field2; actionDataEnabled = field3 == 1;
                        break;
                    case 2: // explicit progress report
                        if (hasReset && field2 >= 0) Move(field2);
                        break;
                    case 3: // additional work changes the denominator
                        if (hasReset && field2 >= 0) total = Math.Min(Int64.MaxValue - field2, total) + field2;
                        break;
                }
            }
        }

        private void Move(long ticks)
        {
            if (backwards) position = Math.Max(0, position - ticks);
            else position = Math.Min(total, position + Math.Min(ticks, Int64.MaxValue - position));
        }

        public void AcceptActionData()
        {
            lock (gate) { if (!final && hasReset && actionDataEnabled) Move(actionTicks); }
        }

        public void AcceptAction(string action, string description)
        {
            lock (gate)
            {
                if (final) return;
                // Do not echo arbitrary MSI record fields or file paths into the product UI.
                if (backwards) { phase = "正在回滚安装"; detail = "Windows Installer 正在撤回本次变更"; return; }
                phase = "正在安装 SusuClash";
                switch (action)
                {
                    case "InstallFiles": detail = "正在复制应用文件"; break;
                    case "CreateShortcuts": detail = "正在创建应用快捷方式"; break;
                    case "WriteRegistryValues": detail = "正在保存当前用户的安装信息"; break;
                    case "RemoveExistingProducts": detail = "正在更新已有版本"; break;
                    case "InstallValidate": detail = "正在核对安装条件"; break;
                    case "InstallFinalize": detail = "正在提交安装变更，请等待引擎完成"; break;
                    default: detail = "Windows Installer 正在处理安装步骤"; break;
                }
            }
        }

        public void SetCancellationAllowed(bool allowed) { lock (gate) { if (!final) canCancel = allowed; } }
        public void RequestCancel() { lock (gate) { if (canCancel && !backwards && !final) cancelRequested = true; } }

        public void AcceptRebootState(string reportingProductCode, bool required)
        {
            lock (gate)
            {
                if (final || !String.Equals(productCode, reportingProductCode, StringComparison.OrdinalIgnoreCase)) return;
                if (restartRequired.HasValue && restartRequired.Value != required) rebootStateConflict = true;
                else restartRequired = required;
            }
        }

        // INSTALLMESSAGE_INSTALLEND has ProductName, ProductCode, MSI action status.
        // A real isolated MSI observed status 1 with MsiInstallProduct's Win32 result 0.
        // Its field 3 must NOT be interpreted as 0/1602/3010/1641 process exit codes.
        // Filter nested RemoveExistingProducts messages to the package initialized by this UI.
        // Shutdown/Terminate, 100% ticks, and InstallFinalize are never success evidence.
        public void AcceptInstallEnd(string endedProductCode, int code)
        {
            lock (gate)
            {
                if (final || sawEnd || !String.Equals(productCode, endedProductCode, StringComparison.OrdinalIgnoreCase)) return;
                sawEnd = true; engineStatus = code; final = true; canCancel = false;
                if (code == 1 && restartRequired.HasValue && !rebootStateConflict)
                    outcome = restartRequired.Value ? InstallerOutcome.RestartRequired : InstallerOutcome.Success;
                else if (code == 2) outcome = InstallerOutcome.Cancelled;
                else if (code == 3) outcome = InstallerOutcome.Failure;
                else outcome = InstallerOutcome.Unknown;
                SetFinalCopy();
            }
        }

        public void Shutdown()
        {
            lock (gate)
            {
                final = true; canCancel = false;
                // Missing final engine evidence remains unknown, even after an error-free UI run.
                SetFinalCopy();
            }
        }

        private void SetFinalCopy()
        {
            switch (outcome)
            {
                case InstallerOutcome.Success: phase = "安装完成"; detail = "Windows Installer 已确认安装成功"; break;
                case InstallerOutcome.RestartRequired: phase = "安装完成，需要重启"; detail = "请保存工作后自行重启 Windows"; break;
                case InstallerOutcome.Cancelled: phase = "安装已取消"; detail = "Windows Installer 已结束本次安装"; break;
                case InstallerOutcome.Failure: phase = "安装未完成"; detail = "Windows Installer 返回安装失败，请查看安装日志"; break;
                default: phase = "安装结果未确认"; detail = "安装结果或提交后状态未确认，请查看 Windows Installer 日志"; break;
            }
        }
    }
}

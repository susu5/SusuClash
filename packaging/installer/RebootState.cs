using System;
using WixToolset.Dtf.WindowsInstaller;

namespace SusuClash.Installer
{
    // A separate immediate CA, scheduled after InstallFinalize. This is the only place
    // that reads reboot mode: its Session is valid here, unlike the UI's expired handle.
    // It reads installer state and sends a typed INFO receipt; it changes no system state.
    public static class RebootState
    {
        [CustomAction]
        public static ActionResult ReportRebootState(Session session)
        {
            try
            {
                string productCode = session["ProductCode"];
                Guid parsed;
                if (!Guid.TryParse(productCode, out parsed)) return ActionResult.Success;
                bool required = session.GetMode(InstallRunMode.RebootAtEnd);
                using (Record receipt = new Record(3))
                {
                    receipt.FormatString = "[1] [2] [3]";
                    receipt.SetString(1, InstallerPolicy.RebootStateMarker);
                    receipt.SetString(2, productCode);
                    receipt.SetInteger(3, required ? 1 : 0);
                    session.Message(InstallMessage.Info, receipt);
                }
            }
            catch { /* Missing receipt leaves UI result unconfirmed; reporting must not fail installation. */ }
            return ActionResult.Success;
        }
    }
}

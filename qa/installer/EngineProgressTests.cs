using System;
using System.Threading;
using SusuClash.Installer;

internal static class EngineProgressTests
{
    private const string Product = "{8A8D5949-F067-42D3-81A4-23E848508F63}";
    private static int passed, failed;
    private static void Check(bool value, string message) { if (!value) throw new Exception(message); }
    private static void Equal<T>(T expected, T actual, string message) { Check(Object.Equals(expected, actual), message + " expected=" + expected + " actual=" + actual); }
    private static EngineProgress New() { return new EngineProgress(Product); }
    private static void Test(string name, Action run)
    {
        try { run(); passed++; Console.WriteLine("PASS " + name); }
        catch (Exception error) { failed++; Console.WriteLine("FAIL " + name + ": " + error.Message); }
    }
    public static int Main()
    {
        Test("only full fresh install admits embedded UI", delegate {
            Check(InstallerPolicy.ShouldHandleUI(5, "", "", ""), "fresh full UI");
            Check(InstallerPolicy.ShouldHandleUI(5 | 0x80, null, null, null), "mask UI option flags");
            foreach (int level in new int[] { 0, 1, 2, 3, 4 }) Check(!InstallerPolicy.ShouldHandleUI(level, "", "", ""), "must decline level " + level);
        });
        Test("maintenance uninstall and repair decline without custom UI", delegate {
            Check(!InstallerPolicy.ShouldHandleUI(5, "1", "", ""), "installed product");
            Check(!InstallerPolicy.ShouldHandleUI(5, "", "ALL", ""), "remove all");
            Check(!InstallerPolicy.ShouldHandleUI(5, "", "MainFeature", ""), "remove feature");
            Check(!InstallerPolicy.ShouldHandleUI(5, "", "", "ALL"), "repair");
        });
        Test("launch requires confirmed success explicit Finish and fixed directory", delegate {
            Check(InstallerPolicy.ShouldLaunch(InstallerOutcome.Success, true, true, true), "all launch preconditions");
            Check(!InstallerPolicy.ShouldLaunch(InstallerOutcome.Success, false, true, true), "X or abnormal exit is not Finish");
            Check(!InstallerPolicy.ShouldLaunch(InstallerOutcome.Success, true, false, true), "unchecked launch");
            Check(!InstallerPolicy.ShouldLaunch(InstallerOutcome.Success, true, true, false), "unexpected launch path");
            foreach (InstallerOutcome outcome in new InstallerOutcome[] { InstallerOutcome.Unknown, InstallerOutcome.RestartRequired, InstallerOutcome.Cancelled, InstallerOutcome.Failure })
                Check(!InstallerPolicy.ShouldLaunch(outcome, true, true, true), "must not launch after " + outcome);
        });
        Test("missing reset never invents a percentage", delegate {
            EngineProgress model = New();
            model.AcceptProgress(2, 500, 0, 0); model.AcceptActionData(); model.AcceptAction("InstallFiles", "ignored");
            Equal<int?>(null, model.Snapshot.Percent, "no engine total");
            Equal(InstallerOutcome.Unknown, model.Outcome, "no result yet");
        });
        Test("elapsed wall clock does not move progress", delegate {
            EngineProgress model = New(); model.AcceptProgress(0, 100, 0, 0); model.AcceptProgress(2, 17, 0, 0);
            Thread.Sleep(80); Equal<int?>(17, model.Snapshot.Percent, "no simulated timer");
        });
        Test("explicit MSI progress updates percentage", delegate {
            EngineProgress model = New(); model.AcceptProgress(0, 200, 0, 0); model.AcceptProgress(2, 50, 0, 0);
            Equal<int?>(25, model.Snapshot.Percent, "50 of 200");
        });
        Test("action data only advances after MSI enables its tick count", delegate {
            EngineProgress model = New(); model.AcceptProgress(0, 100, 0, 0); model.AcceptActionData();
            Equal<int?>(0, model.Snapshot.Percent, "disabled initially");
            model.AcceptProgress(1, 7, 1, 0); model.AcceptActionData(); model.AcceptActionData();
            Equal<int?>(14, model.Snapshot.Percent, "two actions");
            model.AcceptProgress(1, 7, 0, 0); model.AcceptActionData(); Equal<int?>(14, model.Snapshot.Percent, "disabled again");
        });
        Test("added work changes real denominator", delegate {
            EngineProgress model = New(); model.AcceptProgress(0, 100, 0, 0); model.AcceptProgress(2, 50, 0, 0);
            model.AcceptProgress(3, 100, 0, 0); Equal<int?>(25, model.Snapshot.Percent, "new total 200");
        });
        Test("full ticks and InstallFinalize are not success evidence", delegate {
            EngineProgress model = New(); model.AcceptProgress(0, 100, 0, 0); model.AcceptProgress(2, 500, 0, 0);
            model.AcceptAction("InstallFinalize", "ignored"); Equal<int?>(99, model.Snapshot.Percent, "reserve 100 for result");
            Check(!model.Snapshot.IsFinal, "engine still active"); Equal(InstallerOutcome.Unknown, model.Outcome, "not confirmed");
        });
        Test("reset replaces prior action data and total", delegate {
            EngineProgress model = New(); model.AcceptProgress(0, 100, 0, 0); model.AcceptProgress(1, 30, 1, 0); model.AcceptActionData();
            model.AcceptProgress(0, 200, 0, 1); model.AcceptActionData(); Equal<int?>(0, model.Snapshot.Percent, "new reset starts fresh");
        });
        Test("invalid MSI records cannot move the model", delegate {
            EngineProgress model = New(); model.AcceptProgress(0, -1, 0, 0); Equal<int?>(null, model.Snapshot.Percent, "invalid total");
            model.AcceptProgress(0, 100, 0, 0); model.AcceptProgress(2, -1, 0, 0); model.AcceptProgress(0, 100, 9, 0);
            model.AcceptProgress(0, 100, 0, 9); model.AcceptProgress(3, -1, 0, 0); model.AcceptProgress(99, 90, 0, 0);
            Equal<int?>(0, model.Snapshot.Percent, "invalid fields ignored");
        });
        Test("zero total stays indeterminate", delegate {
            EngineProgress model = New(); model.AcceptProgress(0, 0, 0, 0); model.AcceptProgress(2, Int32.MaxValue, 0, 0);
            Equal<int?>(null, model.Snapshot.Percent, "zero work total");
        });
        Test("large tick totals do not overflow or finish", delegate {
            EngineProgress model = New(); model.AcceptProgress(0, Int32.MaxValue, 0, 0);
            for (int i = 0; i < 100; i++) model.AcceptProgress(3, Int32.MaxValue, 0, 0);
            model.AcceptProgress(2, Int32.MaxValue, 0, 0); Equal<int?>(0, model.Snapshot.Percent, "long denominator");
            for (int i = 0; i < 102; i++) model.AcceptProgress(2, Int32.MaxValue, 0, 0);
            Equal<int?>(99, model.Snapshot.Percent, "saturated unfinished");
        });
        Test("rollback reports backwards and cannot cancel again", delegate {
            EngineProgress model = New(); model.RequestCancel(); model.AcceptProgress(0, 100, 1, 0);
            Check(model.Snapshot.IsRollback && !model.Snapshot.CanCancel && !model.ShouldReturnCancel, "safe rollback state");
            model.AcceptProgress(2, 30, 0, 0); Equal<int?>(70, model.Snapshot.Percent, "backward progress");
            model.AcceptAction("InstallFiles", "foreign detail"); Check(model.Snapshot.Phase.Contains("回滚"), "rollback copy remains");
            model.AcceptProgress(2, 200, 0, 0); Equal<int?>(0, model.Snapshot.Percent, "backwards lower clamp");
        });
        Test("cancellation requests wait for engine result", delegate {
            EngineProgress model = New(); model.RequestCancel();
            Check(model.ShouldReturnCancel && model.Snapshot.CancellationRequested && !model.Snapshot.CanCancel, "request latched");
            Check(!model.Snapshot.IsFinal, "request is not completion"); Equal(InstallerOutcome.Unknown, model.Outcome, "no fabricated cancellation result");
        });
        Test("disabled cancellation requires another user request", delegate {
            EngineProgress model = New(); model.SetCancellationAllowed(false); model.RequestCancel();
            Check(!model.ShouldReturnCancel && !model.Snapshot.CancellationRequested, "disabled button no request");
            model.SetCancellationAllowed(true); Check(!model.ShouldReturnCancel, "not implicitly requested");
            model.RequestCancel(); Check(model.ShouldReturnCancel, "fresh click accepted");
        });
        Test("engine cancellation suppression preserves pending intent", delegate {
            EngineProgress model = New(); model.RequestCancel(); model.SetCancellationAllowed(false);
            Check(!model.ShouldReturnCancel && model.Snapshot.CancellationRequested, "no cancel returned during suppression");
            model.SetCancellationAllowed(true); Check(model.ShouldReturnCancel, "pending request returns when safe");
        });
        Test("nested product result cannot complete current install", delegate {
            EngineProgress model = New(); model.AcceptInstallEnd("{1E7741B2-EDB6-4DB0-9A64-F115FB5638BE}", 1);
            Check(!model.Snapshot.IsFinal, "old product uninstall result ignored"); Equal<int?>(null, model.EngineStatus, "foreign action status ignored");
            model.AcceptRebootState(Product.ToLowerInvariant(), false); model.AcceptInstallEnd(Product.ToLowerInvariant(), 1);
            Equal(InstallerOutcome.Success, model.Outcome, "own code case insensitive");
        });
        Test("actual action status one plus read-only no-reboot receipt confirms success", delegate {
            EngineProgress model = New(); model.AcceptRebootState(Product, false); model.AcceptInstallEnd(Product, 1);
            Equal(InstallerOutcome.Success, model.Outcome, "actual embedded MSI action result");
            Equal<int?>(1, model.EngineStatus, "preserve raw action status, not Win32 zero"); Equal<bool?>(false, model.RestartRequired, "read-only mode false");
            Equal<int?>(100, model.Snapshot.Percent, "only confirmed success finishes"); Check(model.Snapshot.IsFinal && !model.Snapshot.CanCancel, "terminal success");
        });
        Test("read-only reboot receipt distinguishes restart-required success", delegate {
            EngineProgress model = New(); model.AcceptRebootState(Product, true); model.AcceptInstallEnd(Product, 1);
            Equal(InstallerOutcome.RestartRequired, model.Outcome, "MSI mode receipt"); Equal<bool?>(true, model.RestartRequired, "raw reboot state");
            Equal<int?>(100, model.Snapshot.Percent, "engine success requiring reboot");
            Check(!InstallerPolicy.ShouldLaunch(model.Outcome, true, true, true), "never launch before required reboot");
        });
        Test("success-shaped end without reboot receipt remains unknown", delegate {
            EngineProgress model = New(); model.AcceptInstallEnd(Product, 1);
            Equal(InstallerOutcome.Unknown, model.Outcome, "incomplete evidence"); Equal<int?>(1, model.EngineStatus, "retain observed action status");
            Check(model.Snapshot.Percent != 100 && !InstallerPolicy.ShouldLaunch(model.Outcome, true, true, true), "no unconfirmed success or launch");
            model.AcceptRebootState(Product, false); Equal(InstallerOutcome.Unknown, model.Outcome, "late receipt cannot rewrite terminal evidence");
        });
        Test("foreign product reboot receipt cannot authorize current success", delegate {
            EngineProgress model = New(); model.AcceptRebootState("{1E7741B2-EDB6-4DB0-9A64-F115FB5638BE}", false); model.AcceptInstallEnd(Product, 1);
            Equal<bool?>(null, model.RestartRequired, "foreign receipt ignored"); Equal(InstallerOutcome.Unknown, model.Outcome, "own receipt required");
        });
        Test("conflicting reboot receipts fail closed", delegate {
            EngineProgress model = New(); model.AcceptRebootState(Product, false); model.AcceptRebootState(Product, true); model.AcceptRebootState(Product, false); model.AcceptInstallEnd(Product, 1);
            Equal(InstallerOutcome.Unknown, model.Outcome, "conflict is not washed out by a third receipt"); Check(model.Snapshot.Percent != 100, "no fabricated completion");
        });
        Test("repeated identical reboot receipts are idempotent", delegate {
            EngineProgress model = New(); model.AcceptRebootState(Product, false); model.AcceptRebootState(Product, false); model.AcceptInstallEnd(Product, 1);
            Equal(InstallerOutcome.Success, model.Outcome, "same evidence can repeat");
        });
        Test("reboot receipt without InstallEnd is not success", delegate {
            EngineProgress model = New(); model.AcceptRebootState(Product, false); model.Shutdown();
            Equal(InstallerOutcome.Unknown, model.Outcome, "state query is not commit result"); Equal<int?>(null, model.EngineStatus, "no fabricated result");
            Check(model.Snapshot.Percent != 100, "no completion from receipt alone");
        });
        foreach (int result in new int[] { 2, 3, 4, 0, 1602, 3010, 1641, 1603, 1618 })
        {
            int captured = result;
            Test("embedded action status is distinct from process exit code " + captured, delegate {
                EngineProgress model = New(); model.AcceptRebootState(Product, false); model.AcceptInstallEnd(Product, captured);
                InstallerOutcome expected = captured == 2 ? InstallerOutcome.Cancelled : captured == 3 ? InstallerOutcome.Failure : InstallerOutcome.Unknown;
                Equal(expected, model.Outcome, "action status mapping"); Equal<int?>(captured, model.EngineStatus, "preserve raw action status");
                Check(model.Snapshot.IsFinal && !model.Snapshot.CanCancel && !model.ShouldReturnCancel, "terminal gate");
                Check(model.Snapshot.Percent != 100, "non-success is not 100% success");
            });
        }
        Test("Shutdown without InstallEnd preserves unknown result", delegate {
            EngineProgress model = New(); model.AcceptProgress(0, 100, 0, 0); model.AcceptProgress(2, 100, 0, 0); model.Shutdown();
            Equal(InstallerOutcome.Unknown, model.Outcome, "missing final result"); Equal<int?>(null, model.EngineStatus, "no invented action status");
            Check(model.Snapshot.IsFinal && model.Snapshot.Percent != 100 && !model.Snapshot.CanCancel, "safe incomplete shutdown");
        });
        Test("late callback after shutdown cannot invent success", delegate {
            EngineProgress model = New(); model.Shutdown(); model.AcceptRebootState(Product, false); model.AcceptInstallEnd(Product, 1);
            Equal(InstallerOutcome.Unknown, model.Outcome, "shutdown result remains unknown");
            Equal<int?>(null, model.EngineStatus, "late record ignored"); Equal<bool?>(null, model.RestartRequired, "late state ignored"); Check(model.Snapshot.Percent != 100, "no late success display");
        });
        Test("later result or progress cannot overwrite confirmed failure", delegate {
            EngineProgress model = New(); model.AcceptInstallEnd(Product, 3); model.AcceptRebootState(Product, false); model.AcceptInstallEnd(Product, 1);
            model.AcceptProgress(0, 1, 0, 0); model.AcceptProgress(2, 1, 0, 0); model.RequestCancel(); model.Shutdown();
            Equal(InstallerOutcome.Failure, model.Outcome, "first result retained"); Equal<int?>(3, model.EngineStatus, "failure retained");
            Check(!model.ShouldReturnCancel && model.Snapshot.Percent != 100, "terminal stays failed");
        });
        Test("arbitrary action descriptions and paths stay out of UI", delegate {
            EngineProgress model = New(); model.AcceptAction("SecretAction", "C:\\Users\\private\\auth.json secret-token");
            Check(!model.Snapshot.Detail.Contains("private") && !model.Snapshot.Detail.Contains("secret"), "untrusted description not echoed");
        });
        Console.WriteLine("RESULT passed=" + passed + " failed=" + failed);
        return failed == 0 ? 0 : 1;
    }
}

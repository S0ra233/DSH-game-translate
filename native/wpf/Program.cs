using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using System.Windows;
using System.Xml;
using System.Xaml;

[assembly: System.Reflection.AssemblyTitle("DSH 游戏翻译")]
[assembly: System.Reflection.AssemblyVersion("0.3.7.0")]

namespace DshTranslate
{
    internal static class Program
    {
        private static string Argument(string[] args, string name, string fallback = "")
        { for (int i = 0; i + 1 < args.Length; i++) if (args[i] == name) return args[i + 1]; return fallback; }
        [STAThread]
        private static int Main(string[] args)
        {
            if (Array.IndexOf(args, "--wire-test") >= 0) { PipeClient.WireTest(); return 0; }
            if (Array.IndexOf(args, "--request-test") >= 0) { PipeClient.RequestTest(); return 0; }
            if (Array.IndexOf(args, "--check") >= 0)
            {
                try { Check(Argument(args, "--check")); return 0; }
                catch (Exception error) { Console.Error.WriteLine(error.ToString()); return 2; }
            }
            PipeClient pipe = new PipeClient();
            try
            {
                Dictionary<string, object> bootstrap = pipe.Bootstrap();
                Native.SetCurrentProcessExplicitAppUserModelID("DeepSeekHarness.DSH-translate");
                Application app = new Application { ShutdownMode = ShutdownMode.OnMainWindowClose };
                BrowserWindow host = new BrowserWindow(pipe, bootstrap, Argument(args, "--profile-dir"), Argument(args, "--icon"));
                app.MainWindow = host.Window; pipe.Start(); app.Run(host.Window); return 0;
            }
            catch (Exception error)
            {
                pipe.Send(Data.Fields("kind", "fatal", "message", "原生翻译窗口启动失败：" + error.GetType().Name + " — " + error.Message)); return 1;
            }
        }
        private static void Require(bool condition, string message) { if (!condition) throw new InvalidDataException(message); }
        private static void Check(string output)
        {
            // No Application, Window, browser, HWND or paid model is constructed by this branch.
            XmlDocument xml = new XmlDocument(); xml.Load(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "BrowserWindow.xaml"));
            XamlSchemaContext schema = new XamlSchemaContext(new System.Reflection.Assembly[] { typeof(Window).Assembly, typeof(System.Windows.Media.Color).Assembly, typeof(DependencyObject).Assembly });
            using (XamlXmlReader reader = new XamlXmlReader(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "BrowserWindow.xaml"), schema))
            {
                while (reader.Read())
                {
                    if (reader.NodeType == XamlNodeType.StartObject) Require(!reader.Type.IsUnknown, "Unknown XAML type: " + reader.Type.Name);
                    if (reader.NodeType == XamlNodeType.StartMember) Require(!reader.Member.IsUnknown, "Unknown XAML member: " + reader.Member.Name);
                }
            }
            Require(xml.DocumentElement.GetAttribute("AllowsTransparency") == "False", "layered window must stay disabled");
            Require(xml.DocumentElement.GetAttribute("Topmost") == "False" && xml.DocumentElement.GetAttribute("ShowInTaskbar") == "True", "ordinary top-level window");
            XmlNamespaceManager ns = new XmlNamespaceManager(xml.NameTable); ns.AddNamespace("x", "http://schemas.microsoft.com/winfx/2006/xaml");
            foreach (string name in new string[] { "Root", "MilkLayer", "LightLayer", "RimLayer", "WebSurface", "TitleDrag", "Minimize", "Maximize", "Close" })
                Require(xml.SelectSingleNode("//*[@x:Name='" + name + "']", ns) != null, "Missing UI: " + name);
            string root = Path.GetFullPath(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "..", ".."));
            Dictionary<string, object> material = Data.Parse(File.ReadAllText(Path.Combine(root, "src", "material.json"), Encoding.UTF8));
            Require(Data.Number(Data.Get(material, "milk"), -1) == 5 && Data.Number(Data.Get(material, "softLight"), -1) == 15, "approved adjustable defaults");
            Require(Data.Number(Data.Get(material, "edgeReflection"), -1) == 100 && Data.Number(Data.Get(material, "lightSpread"), -1) == 100 && Data.Number(Data.Get(material, "readerWhite"), -1) == 20, "approved fixed defaults");
            Appearance migrated = Appearance.Read(Data.Fields("surface", "glass", "frost", 100, "fontSize", 20));
            Require(migrated.Milk == 5 && migrated.Light == 15 && migrated.FontSize == 20 && migrated.Surface == "glass", "legacy migration");
            Appearance custom = Appearance.Read(Data.Fields("materialVersion", 2, "milk", 200, "softLight", -4));
            Require(custom.Milk == 80 && custom.Light == 0 && !custom.Export().ContainsKey("frost") && !custom.Export().ContainsKey("apiKey"), "appearance bounds/filter");
            MaterialTween tween = new MaterialTween(); tween.Snap(5, 15);
            for (int i = 0; i < 1000; i++) tween.Target(i % 2 == 0 ? 0 : 80, i % 2 == 0 ? 80 : 0);
            Require(tween.Milk == 5 && tween.Light == 15, "input must not paint synchronously");
            tween.Step(16); Require(tween.Milk > 5 && tween.Milk < 80 && tween.Light > 0 && tween.Light < 15, "continuous transition");
            tween.Target(5, 15); bool moving = true; int frames = 0;
            while (moving && frames++ < 100) moving = tween.Step(16);
            Require(!moving && tween.Milk == 5 && tween.Light == 15, "retarget and settle");
            Require(!PipeClient.Allowed.Contains("pick-game") && !PipeClient.Allowed.Contains("execute-shell") && PipeClient.Allowed.Contains("translate"), "controlled IPC actions");
            Require(PipeClient.Allowed.Contains("edit-translation"), "manual edit IPC");
            Require(PipeClient.Allowed.Contains("reading-groups") && PipeClient.Allowed.Contains("reading-group"), "reading group IPC");
            Require(BrowserWindow.IsLocalAsset("https://translation.dsh.local/translation-ui.js") && !BrowserWindow.IsLocalAsset("https://example.com/a.js"), "local assets only");
            Require(!BrowserWindow.IsLocalPage("https://translation.dsh.local/translation-ui.html?other"), "page identity");
            string runtime = Microsoft.Web.WebView2.Core.CoreWebView2Environment.GetAvailableBrowserVersionString();
            Require(runtime.Length > 0, "WebView2 runtime missing");
            File.WriteAllText(output, Data.Serialize(Data.Fields("xaml", true, "approvedDefaults", true, "migration", true, "materialTween", true,
                "originalUi", File.Exists(Path.Combine(root, "dist", "translation-ui.js")), "runtime", runtime, "stdioActions", true, "nativeProtocol", PipeClient.Protocol(), "createdWindow", false, "visualAcceptance", "not_run")), new UTF8Encoding(false));
        }
    }
}

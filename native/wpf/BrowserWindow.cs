using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Interop;
using System.Windows.Markup;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using System.Windows.Threading;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.Wpf;

namespace DshTranslate
{
    // The original React UI is unchanged. This class owns only native chrome, material and IPC.
    internal sealed class BrowserWindow
    {
        internal readonly Window Window;
        private const string Origin = "https://translation.dsh.local/";
        private readonly PipeClient pipe;
        private readonly WebView2CompositionControl web;
        private readonly Border milk, light;
        private readonly SolidColorBrush milkBrush = new SolidColorBrush(Colors.White);
        private readonly DispatcherTimer frames;
        private readonly MaterialTween tween = new MaterialTween();
        private readonly Stopwatch clock = Stopwatch.StartNew();
        private readonly Dictionary<string, object> bootstrap;
        private readonly string profile;
        private readonly HashSet<string> active = new HashSet<string>();
        private Appearance appearance;
        private IntPtr handle;
        private string appliedSurface = "";
        private double previousFrame;
        private bool forceClose, ready, disposed, picking;
        private WindowState restoreState = WindowState.Normal;

        internal BrowserWindow(PipeClient client, Dictionary<string, object> initial, string profileDirectory, string icon)
        {
            pipe = client; bootstrap = initial; profile = profileDirectory;
            bootstrap["nativeProtocol"] = PipeClient.Protocol();
            Directory.CreateDirectory(profile);
            appearance = Appearance.Read(Data.Get(initial, "appearance"));
            Window = (Window)XamlReader.Parse(File.ReadAllText(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "BrowserWindow.xaml"), Encoding.UTF8));
            milk = Find<Border>("MilkLayer"); milk.Background = milkBrush; light = Find<Border>("LightLayer");
            // Visual composition keeps the same WPF/DWM material visible through transparent UI pixels.
            web = new WebView2CompositionControl { DefaultBackgroundColor = System.Drawing.Color.Transparent, AllowExternalDrop = false };
            Find<Grid>("WebSurface").Children.Add(web);
            // Captured browser images have an intrinsic size. Bound the control to the
            // client area so a previous maximized frame cannot keep the layout enlarged.
            Window.SizeChanged += delegate { SyncViewport(); };
            frames = new DispatcherTimer(DispatcherPriority.Render, Window.Dispatcher) { Interval = TimeSpan.FromMilliseconds(16) };
            frames.Tick += delegate {
                double now = clock.Elapsed.TotalMilliseconds;
                bool moving = tween.Step(now - previousFrame); previousFrame = now; Paint();
                if (!moving || !Window.IsVisible) frames.Stop();
            };
            tween.Snap(appearance.Milk, appearance.Light); Paint();
            if (!string.IsNullOrEmpty(icon) && File.Exists(icon)) {
                BitmapFrame image = BitmapFrame.Create(new Uri(icon)); Window.Icon = image; Find<Image>("AppIcon").Source = image;
            }
            Find<Button>("Minimize").Click += delegate { Window.WindowState = WindowState.Minimized; };
            Find<Button>("Maximize").Click += delegate { ToggleMaximize(); };
            Find<Button>("Close").Click += delegate { Window.Close(); };
            Find<Grid>("TitleDrag").MouseLeftButtonDown += delegate(object sender, MouseButtonEventArgs e) {
                DependencyObject node = e.OriginalSource as DependencyObject;
                while (node != null) { if (node is Button) return; node = VisualTreeHelper.GetParent(node); }
                if (e.ClickCount == 2) ToggleMaximize(); else Window.DragMove();
            };
            Window.SourceInitialized += delegate {
                handle = new WindowInteropHelper(Window).Handle;
                HwndSource.FromHwnd(handle).CompositionTarget.BackgroundColor = Colors.Transparent;
                Native.RegularWindow(handle); ApplyMaterial(true);
            };
            Window.Loaded += async delegate {
                try { SyncViewport(); await InitializeBrowser(); }
                catch (Exception error) { Fatal("翻译界面未能加载：" + error.GetType().Name + " — " + error.Message); }
            };
            Window.StateChanged += delegate {
                if (Window.WindowState != WindowState.Minimized) restoreState = Window.WindowState;
                else frames.Stop();
            };
            Window.Activated += delegate { if (ready && !disposed) Event("refresh"); };
            Window.Closing += delegate(object sender, CancelEventArgs e) {
                if (forceClose) return;
                e.Cancel = true; frames.Stop(); Event("window-hidden"); Window.Hide();
                pipe.Send(Data.Fields("kind", "hidden")); Suspend();
            };
            pipe.Message = message => Window.Dispatcher.BeginInvoke(new Action(delegate { Receive(message); }));
            pipe.Disconnected = () => Window.Dispatcher.BeginInvoke(new Action(Shutdown));
        }
        private T Find<T>(string name) where T : class { return Window.FindName(name) as T; }
        private void SyncViewport()
        {
            double width = Math.Max(0, Window.ActualWidth), height = Math.Max(0, Window.ActualHeight - 38);
            if (Math.Abs(web.Width - width) > .1 || double.IsNaN(web.Width)) web.Width = width;
            if (Math.Abs(web.Height - height) > .1 || double.IsNaN(web.Height)) web.Height = height;
        }
        private void ToggleMaximize() { Window.WindowState = Window.WindowState == WindowState.Maximized ? WindowState.Normal : WindowState.Maximized; }
        private void Fatal(string message) { pipe.Send(Data.Fields("kind", "fatal", "message", message)); Shutdown(); }

        private async Task InitializeBrowser()
        {
            CoreWebView2Environment environment = await CoreWebView2Environment.CreateAsync(null, Path.Combine(profile, "webview2"));
            if (disposed) return;
            await web.EnsureCoreWebView2Async(environment);
            if (disposed) return;
            CoreWebView2 core = web.CoreWebView2;
            core.Settings.AreDefaultContextMenusEnabled = false;
            core.Settings.AreDevToolsEnabled = false;
            core.Settings.AreBrowserAcceleratorKeysEnabled = false;
            core.Settings.IsStatusBarEnabled = false;
            core.Settings.IsZoomControlEnabled = false;
            core.Settings.AreHostObjectsAllowed = false;
            core.Profile.PreferredColorScheme = CoreWebView2PreferredColorScheme.Light;
            core.SetVirtualHostNameToFolderMapping("translation.dsh.local", Path.GetFullPath(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "..", "..", "dist")), CoreWebView2HostResourceAccessKind.DenyCors);
            core.AddWebResourceRequestedFilter("*", CoreWebView2WebResourceContext.All);
            core.WebResourceRequested += delegate(object sender, CoreWebView2WebResourceRequestedEventArgs e) {
                if (!IsLocalAsset(e.Request.Uri)) e.Response = environment.CreateWebResourceResponse(null, 403, "Blocked", "");
            };
            core.NavigationStarting += delegate(object sender, CoreWebView2NavigationStartingEventArgs e) { if (!IsLocalPage(e.Uri)) e.Cancel = true; };
            core.NewWindowRequested += delegate(object sender, CoreWebView2NewWindowRequestedEventArgs e) { e.Handled = true; };
            core.DownloadStarting += delegate(object sender, CoreWebView2DownloadStartingEventArgs e) { e.Cancel = true; };
            core.PermissionRequested += delegate(object sender, CoreWebView2PermissionRequestedEventArgs e) { e.State = CoreWebView2PermissionState.Deny; };
            core.ProcessFailed += delegate { if (!disposed) Fatal("翻译界面进程已退出，请从 DSH 重新打开。原对话任务会保留。"); };
            core.WebMessageReceived += Message;
            core.Navigate(Origin + "translation-ui.html");
        }
        internal static bool IsLocalPage(string address) { return address == Origin + "translation-ui.html"; }
        internal static bool IsLocalAsset(string address) { return IsLocalPage(address) || address == Origin + "translation-ui.js"; }
        private void Post(object message) { if (!disposed && web.CoreWebView2 != null) web.CoreWebView2.PostWebMessageAsJson(Data.Serialize(message)); }
        private void Event(string name) { if (ready) Post(Data.Fields("kind", "event", "name", name)); }
        private async void Message(object sender, CoreWebView2WebMessageReceivedEventArgs e)
        {
            if (disposed || !IsLocalPage(e.Source) || e.WebMessageAsJson.Length > 1048576) return;
            Dictionary<string, object> message;
            try { message = Data.Parse(e.WebMessageAsJson); } catch (ArgumentException) { return; }
            string kind = Data.Text(message, "kind");
            if (kind == "bootstrap-request") { if (!ready) Post(bootstrap); return; }
            if (kind == "ready") { if (!ready) { ready = true; pipe.Send(Data.Fields("kind", "ready")); } return; }
            if (!ready) return;
            if (kind == "material") {
                object value = Data.Get(message, "preferences");
                appearance.Surface = Data.Text(value, "surface") == "glass" ? "glass" : "white";
                appearance.Milk = Data.Bound(Data.Get(value, "milk"), 0, 80, 5);
                appearance.Light = Data.Bound(Data.Get(value, "softLight"), 0, 80, 15);
                ApplyMaterial(false); return;
            }
            if (kind != "request") return;
            string id = Data.Text(message, "id"), action = Data.Text(message, "action");
            if (id.Length == 0 || id.Length > 120 || active.Count >= 32 || !active.Add(id)) return;
            try {
                object result;
                if (action == "pick-game" || action == "pick-output") {
                    if (picking) throw new InvalidOperationException("目录选择窗口已经打开");
                    picking = true;
                    try {
                        // Leave the WebView callback before entering the native modal picker.
                        string path = await Window.Dispatcher.InvokeAsync(() => FolderPicker.Pick(handle, action == "pick-game" ? "选择游戏目录" : "选择输出位置"), DispatcherPriority.Background);
                        result = await pipe.Directory(action, path);
                    }
                    finally { picking = false; }
                } else {
                    if (!PipeClient.Allowed.Contains(action)) throw new InvalidOperationException("不支持的窗口操作");
                    object args = Data.Get(message, "args");
                    if (action == "native-appearance") {
                        appearance = Appearance.Read(Data.Get(args, "preferences"));
                        bootstrap["appearance"] = appearance.Export();
                        args = Data.Fields("preferences", appearance.Export()); ApplyMaterial(false);
                    }
                    result = await pipe.Call(action, args);
                }
                Post(Data.Fields("kind", "response", "id", id, "ok", true, "value", result));
            } catch (Exception error) { Post(Data.Fields("kind", "response", "id", id, "ok", false, "error", error.Message)); }
            finally { active.Remove(id); }
        }
        private void ApplyMaterial(bool snap)
        {
            if (handle != IntPtr.Zero && appliedSurface != appearance.Surface) {
                int result = Native.Material(handle, appearance.Surface == "glass");
                appliedSurface = appearance.Surface;
                if (result < 0) { appearance.Surface = "white"; appliedSurface = "white"; Native.Material(handle, false); }
            }
            if (snap || appearance.Surface != "glass" || !SystemParameters.ClientAreaAnimation || !Window.IsVisible) {
                frames.Stop(); tween.Snap(appearance.Milk, appearance.Light); Paint();
            } else {
                tween.Target(appearance.Milk, appearance.Light);
                if (!frames.IsEnabled) { previousFrame = clock.Elapsed.TotalMilliseconds; frames.Start(); }
            }
        }
        private void Paint()
        {
            bool glass = appearance.Surface == "glass";
            Color color = Color.FromArgb(glass ? (byte)Math.Round(tween.Milk * 2.55, MidpointRounding.AwayFromZero) : (byte)255, 255, 255, 255);
            if (milkBrush.Color != color) milkBrush.Color = color;
            double opacity = glass ? tween.Light / 100 : 0;
            if (Math.Abs(light.Opacity - opacity) > .0001) light.Opacity = opacity;
            Find<Border>("RimLayer").Opacity = glass ? 1 : .25;
        }
        private async void Suspend()
        {
            // The browser gets one turn to clear dialogs/keys before suspending.
            try {
                if (web.CoreWebView2 != null) {
                    await web.CoreWebView2.TrySuspendAsync();
                    if (!disposed && Window.IsVisible) web.CoreWebView2.Resume();
                }
            }
            catch (InvalidOperationException) { } catch (System.Runtime.InteropServices.COMException) { }
        }
        private void Receive(Dictionary<string, object> message)
        {
            if (disposed) return;
            if (Data.Text(message, "kind") == "window") {
                if (Data.Text(message, "action") == "close") { Shutdown(); return; }
                if (Data.Text(message, "action") == "focus") {
                    if (web.CoreWebView2 != null) web.CoreWebView2.Resume();
                    Window.WindowState = restoreState; Window.Show(); Window.Activate();
                    Event("refresh"); pipe.Send(Data.Fields("kind", "visible"));
                }
            } else if (Data.Text(message, "kind") == "event" && Window.IsVisible) Event(Data.Text(message, "name"));
        }
        private void Shutdown()
        {
            if (disposed) return; forceClose = true; disposed = true; frames.Stop(); FolderPicker.Cancel(); web.Dispose(); Window.Close();
        }
    }
}

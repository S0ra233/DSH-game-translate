using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;

namespace DshTranslate
{
    internal static class Data
    {
        internal static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 16777216 };
        internal static Dictionary<string, object> Map(object value) { return value as Dictionary<string, object> ?? new Dictionary<string, object>(); }
        internal static object Get(object value, string key) { object result; return Map(value).TryGetValue(key, out result) ? result : null; }
        internal static string Text(object value) { return value == null ? "" : Convert.ToString(value, CultureInfo.InvariantCulture); }
        internal static string Text(object value, string key) { return Text(Get(value, key)); }
        internal static object[] List(object value, string key) { return Get(value, key) as object[] ?? new object[0]; }
        internal static double Number(object value, double fallback)
        {
            double number;
            return value != null && !(value is bool) && double.TryParse(Text(value), NumberStyles.Float, CultureInfo.InvariantCulture, out number) && !double.IsNaN(number) && !double.IsInfinity(number) ? number : fallback;
        }
        internal static double Bound(object value, double low, double high, double fallback) { return Math.Max(low, Math.Min(high, Number(value, fallback))); }
        internal static bool True(object value) { return value is bool && (bool)value; }
        internal static Dictionary<string, object> Fields(params object[] entries)
        {
            Dictionary<string, object> result = new Dictionary<string, object>();
            for (int i = 0; i < entries.Length; i += 2) result[(string)entries[i]] = entries[i + 1];
            return result;
        }
        internal static string Serialize(object value) { lock (Json) return Json.Serialize(value); }
        internal static Dictionary<string, object> Parse(string value) { lock (Json) return Map(Json.DeserializeObject(value)); }
    }

    internal sealed class Appearance
    {
        internal string Surface = "white", Font = "system";
        internal double Milk = 5, Light = 15, FontSize = 16, LineHeight = 1.8, Ratio = 50;
        internal static Appearance Read(object input)
        {
            bool current = Data.Number(Data.Get(input, "materialVersion"), 0) == 2;
            Appearance value = new Appearance();
            value.Surface = Data.Text(input, "surface") == "glass" ? "glass" : "white";
            value.Font = Data.Text(input, "font") == "serif" ? "serif" : "system";
            value.Milk = current ? Data.Bound(Data.Get(input, "milk"), 0, 80, 5) : 5;
            value.Light = current ? Data.Bound(Data.Get(input, "softLight"), 0, 80, 15) : 15;
            value.FontSize = Data.Bound(Data.Get(input, "fontSize"), 12, 24, 16);
            value.Ratio = Data.Bound(Data.Get(input, "ratio"), 35, 65, 50);
            double line = Data.Number(Data.Get(input, "lineHeight"), 1.8);
            value.LineHeight = line == 1.5 || line == 1.8 || line == 2.1 ? line : 1.8;
            return value;
        }
        internal Dictionary<string, object> Export()
        {
            return Data.Fields("materialVersion", 2, "surface", Surface, "font", Font, "fontSize", FontSize,
                "lineHeight", LineHeight, "ratio", Ratio, "milk", Milk, "softLight", Light);
        }
    }

    // A single sampled trajectory; setters only replace targets. No per-input animation allocations.
    internal sealed class MaterialTween
    {
        internal double Milk, Light, TargetMilk, TargetLight;
        internal void Snap(double milk, double light) { Milk = TargetMilk = milk; Light = TargetLight = light; }
        internal void Target(double milk, double light) { TargetMilk = milk; TargetLight = light; }
        internal bool Step(double elapsed)
        {
            double amount = 1 - Math.Exp(-Math.Max(0, Math.Min(80, elapsed)) / 45);
            Milk += (TargetMilk - Milk) * amount; Light += (TargetLight - Light) * amount;
            if (Math.Abs(TargetMilk - Milk) < .03 && Math.Abs(TargetLight - Light) < .03) { Snap(TargetMilk, TargetLight); return false; }
            return true;
        }
    }

    internal sealed class PipeClient
    {
        private readonly StreamReader input = new StreamReader(Console.OpenStandardInput(), Encoding.UTF8);
        private readonly StreamWriter output = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false)) { AutoFlush = true };
        private readonly object sync = new object();
        private readonly Dictionary<string, TaskCompletionSource<object>> pending = new Dictionary<string, TaskCompletionSource<object>>();
        private int serial;
        internal Action<Dictionary<string, object>> Message;
        internal Action Disconnected;
        internal static readonly HashSet<string> Allowed = new HashSet<string> { "snapshot", "scenes", "scene", "reading-groups", "reading-group", "save-model", "edit-translation", "initialize", "translate", "build", "native-appearance" };
        internal static Dictionary<string, object> Protocol()
        {
            string[] actions = new string[Allowed.Count]; Allowed.CopyTo(actions);
            return Data.Fields("version", 1, "hostVersion", "0.3.7", "actions", actions);
        }
        internal void Send(object value) { lock (sync) output.WriteLine(Data.Serialize(value)); }
        internal Dictionary<string, object> Bootstrap()
        {
            string line = input.ReadLine();
            if (line == null || line.Length > 16384) throw new InvalidDataException("缺少窗口启动信息");
            Dictionary<string, object> value = Data.Parse(line);
            if (Data.Text(value, "kind") != "bootstrap" || Data.Text(value, "sessionId").Length == 0) throw new InvalidDataException("启动信息无效");
            return value;
        }
        internal Task<object> Call(string action, object args = null)
        {
            if (!Allowed.Contains(action)) throw new InvalidOperationException("不支持的窗口操作");
            string id = "wpf-" + Interlocked.Increment(ref serial).ToString(CultureInfo.InvariantCulture);
            TaskCompletionSource<object> done = new TaskCompletionSource<object>(TaskCreationOptions.RunContinuationsAsynchronously);
            lock (sync) pending[id] = done;
            Send(Data.Fields("kind", "request", "id", id, "action", action, "args", args ?? Data.Fields()));
            return done.Task;
        }
        internal Task<object> Directory(string action, string path)
        {
            if (action != "pick-game" && action != "pick-output") throw new InvalidOperationException("目录操作无效");
            string id = "folder-" + Interlocked.Increment(ref serial).ToString(CultureInfo.InvariantCulture);
            TaskCompletionSource<object> done = new TaskCompletionSource<object>(TaskCreationOptions.RunContinuationsAsynchronously);
            lock (sync) pending[id] = done;
            Send(Data.Fields("kind", "directory-picked", "id", id, "action", action, "path", path));
            return done.Task;
        }
        internal void Start()
        {
            Thread thread = new Thread(delegate()
            {
                try
                {
                    string line;
                    while ((line = input.ReadLine()) != null)
                    {
                        if (line.Length > 2097152) throw new InvalidDataException("窗口协议过大");
                        Dictionary<string, object> message = Data.Parse(line);
                        if (Data.Text(message, "kind") == "response")
                        {
                            string id = Data.Text(message, "id"); TaskCompletionSource<object> done;
                            lock (sync) { if (!pending.TryGetValue(id, out done)) continue; pending.Remove(id); }
                            if (Data.True(Data.Get(message, "ok"))) done.TrySetResult(Data.Get(message, "value"));
                            else done.TrySetException(new InvalidOperationException(Data.Text(message, "error")));
                        }
                        else if (Message != null) Message(message);
                    }
                }
                catch (IOException) { } catch (ArgumentException) { } catch (InvalidOperationException) { }
                finally
                {
                    lock (sync) { foreach (TaskCompletionSource<object> done in pending.Values) done.TrySetCanceled(); pending.Clear(); }
                    if (Disconnected != null) Disconnected();
                }
            });
            thread.IsBackground = true; thread.Name = "DSH translation IPC"; thread.Start();
        }
        internal static void WireTest()
        {
            PipeClient pipe = new PipeClient();
            Dictionary<string, object> bootstrap = Data.Parse(pipe.input.ReadLine());
            if (Data.Text(bootstrap, "kind") != "bootstrap") throw new InvalidDataException("bootstrap required");
            pipe.Send(Data.Fields("kind", "ready"));
            pipe.Send(Data.Fields("kind", "request", "id", "wire-1", "action", "snapshot", "args", Data.Fields()));
            Dictionary<string, object> response = Data.Parse(pipe.input.ReadLine());
            pipe.Send(Data.Fields("kind", "wire-test-complete", "ok", Data.True(Data.Get(response, "ok")), "session", Data.Text(bootstrap, "sessionId")));
        }
        // Exercise the same allowlist, serializer, pending-response matching and
        // pipe.Call path as the window, without constructing any UI or browser.
        internal static void RequestTest()
        {
            PipeClient pipe = new PipeClient();
            Dictionary<string, object> bootstrap = pipe.Bootstrap();
            object request = Data.Get(bootstrap, "request");
            pipe.Start();
            try {
                object value = pipe.Call(Data.Text(request, "action"), Data.Get(request, "args")).GetAwaiter().GetResult();
                pipe.Send(Data.Fields("kind", "request-test-complete", "ok", true, "value", value, "createdWindow", false));
            } catch (Exception error) {
                pipe.Send(Data.Fields("kind", "request-test-complete", "ok", false, "error", error.Message, "createdWindow", false));
            }
        }
    }
}

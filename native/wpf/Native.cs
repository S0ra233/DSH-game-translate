using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;

namespace DshTranslate
{
    internal static class Native
    {
        [StructLayout(LayoutKind.Sequential)] internal struct Margins { public int left, right, top, bottom; }
        [DllImport("dwmapi.dll")] private static extern int DwmSetWindowAttribute(IntPtr hwnd, int attribute, ref int value, int size);
        [DllImport("dwmapi.dll")] private static extern int DwmExtendFrameIntoClientArea(IntPtr hwnd, ref Margins margins);
        [DllImport("user32.dll")] private static extern bool SetWindowPos(IntPtr hwnd, IntPtr after, int x, int y, int width, int height, uint flags);
        [DllImport("user32.dll", EntryPoint = "SetWindowLongPtrW")] private static extern IntPtr SetWindowLongPtr(IntPtr hwnd, int index, IntPtr value);
        [DllImport("shell32.dll", CharSet = CharSet.Unicode)] internal static extern int SetCurrentProcessExplicitAppUserModelID(string value);
        internal static void RegularWindow(IntPtr hwnd)
        {
            // A normal unowned top-level window. Clicking DSH or another app may
            // place it above us; native folder dialogs still own this HWND.
            SetWindowLongPtr(hwnd, -8, IntPtr.Zero);
            SetWindowPos(hwnd, new IntPtr(-2), 0, 0, 0, 0, 0x13); // NOTOPMOST, no move/size/activation
        }
        internal static int Material(IntPtr hwnd, bool glass)
        {
            int light = 0, corner = 2, kind = glass ? 3 : 1;
            DwmSetWindowAttribute(hwnd, 20, ref light, 4); DwmSetWindowAttribute(hwnd, 33, ref corner, 4);
            Margins margins = new Margins { left = -1, right = -1, top = -1, bottom = -1 };
            int frame = DwmExtendFrameIntoClientArea(hwnd, ref margins);
            int result = DwmSetWindowAttribute(hwnd, 38, ref kind, 4);
            return frame < 0 ? frame : result;
        }
    }

    internal static class FolderPicker
    {
        [ComImport, Guid("DC1C5A9C-E88A-4DDE-A5A1-60F82A20AEF7")] private class FileOpenDialog { }
        [ComImport, Guid("D57C7288-D4AD-4768-BE02-9D969532D960"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        private interface Dialog
        {
            [PreserveSig] int Show(IntPtr owner);
            void SetFileTypes(uint count, IntPtr specifications); void SetFileTypeIndex(uint index); void GetFileTypeIndex(out uint index);
            void Advise(IntPtr events, out uint cookie); void Unadvise(uint cookie); void SetOptions(uint options); void GetOptions(out uint options);
            void SetDefaultFolder(Item item); void SetFolder(Item item); void GetFolder(out Item item); void GetCurrentSelection(out Item item);
            void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string name); void GetFileName(out IntPtr name);
            void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string title); void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string label);
            void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string label); void GetResult(out Item item);
            void AddPlace(Item item, uint where); void SetDefaultExtension([MarshalAs(UnmanagedType.LPWStr)] string extension); void Close(int result);
        }
        [ComImport, Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        private interface Item
        {
            void BindToHandler(IntPtr context, ref Guid handler, ref Guid id, out IntPtr value); void GetParent(out Item parent);
            void GetDisplayName(uint type, out IntPtr text); void GetAttributes(uint mask, out uint value); void Compare(Item other, uint hint, out int order);
        }
        private static Dialog active;
        internal static string Pick(IntPtr owner, string title)
        {
            Dialog dialog = (Dialog)new FileOpenDialog(); Item item = null; active = dialog;
            try
            {
                dialog.SetOptions(0x20 | 0x40 | 0x800 | 0x8); dialog.SetTitle(title);
                int result = dialog.Show(owner);
                if (result == unchecked((int)0x800704C7)) return null;
                if (result < 0) Marshal.ThrowExceptionForHR(result);
                dialog.GetResult(out item); IntPtr text;
                item.GetDisplayName(0x80058000, out text);
                try { return Marshal.PtrToStringUni(text); } finally { Marshal.FreeCoTaskMem(text); }
            }
            finally { active = null; if (item != null) Marshal.FinalReleaseComObject(item); Marshal.FinalReleaseComObject(dialog); }
        }
        internal static void Cancel() { if (active != null) active.Close(unchecked((int)0x800704C7)); }
    }
}

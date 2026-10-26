$ErrorActionPreference = 'Stop'
$nativeRoot = $PSScriptRoot
$frameworkRoot = Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319'
$arguments = @('/nologo','/target:winexe','/platform:x64','/optimize+','/codepage:65001','/utf8output',
  ('/out:' + (Join-Path $nativeRoot 'TranslationWindow-0.3.7.exe')),
  ('/win32manifest:' + (Join-Path $nativeRoot 'Window.manifest')))
foreach ($library in @('WPF/PresentationFramework.dll','WPF/PresentationCore.dll','WPF/WindowsBase.dll','System.Xaml.dll','System.Web.Extensions.dll')) {
  $arguments += '/reference:' + (Join-Path $frameworkRoot $library)
}
$arguments += '/reference:System.Drawing.dll'
foreach ($library in @('Microsoft.Web.WebView2.Core.dll','Microsoft.Web.WebView2.Wpf.dll')) { $arguments += '/reference:' + (Join-Path $nativeRoot ('webview2/' + $library)) }
foreach ($source in @('Contracts.cs','Native.cs','BrowserWindow.cs','Program.cs')) { $arguments += Join-Path $nativeRoot $source }
& (Join-Path $frameworkRoot 'csc.exe') @arguments
if ($LASTEXITCODE -ne 0) { throw 'Native window build failed.' }
Write-Output 'Native WPF host built; no window launched.'
